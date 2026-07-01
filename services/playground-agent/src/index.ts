import express, { type Request, type Response } from "express";
import cors from "cors";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { startWalletPool, acquireWallet, retireWallet, walletBalances, type SessionWallet } from "./walletPool.js";
import { McpSession } from "./mcpBridge.js";
import { runAgentTurn, systemPrompt, type AgentEvent } from "./agentLoop.js";
import { faucetAddress, faucetUsdcBalance } from "./faucet.js";
import type { ChatMessage } from "./llm.js";

const log = pino({ name: "playground-agent" });

type TargetKey = "demosdk" | "webtest";
type Target = { url: string; label: string };

type Session = {
  id: string;
  wallet: SessionWallet;
  mcp: McpSession;
  messages: ChatMessage[];
  targets: Record<TargetKey, Target>;
  activeTarget: TargetKey;
  createdAt: number;
  lastUsed: number;
  busy: boolean;
};

const sessions = new Map<string, Session>();

async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  if (!config.turnstileSecret) return true; // dev bypass (local only)
  if (!token) return false;
  const form = new URLSearchParams();
  form.set("secret", config.turnstileSecret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const d = (await r.json()) as { success?: boolean };
    return Boolean(d.success);
  } catch {
    return false;
  }
}

function closeSession(s: Session) {
  sessions.delete(s.id);
  s.mcp.close().catch(() => {});
  // Retire the wallet so it cannot be recycled into a new session. A wallet
  // that has paid for a resource leaves a payer-scoped session entry in the
  // gateway Redis cache (TTL 1 h); retiring prevents a future session from
  // inheriting the same public key and skipping payment for the same resource.
  retireWallet(s.wallet.publicKey);
}

// Expire idle sessions (frees MCP subprocesses).
setInterval(() => {
  const ttl = config.sessionTtlMin * 60_000;
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastUsed > ttl) {
      log.info({ session: s.id }, "session expired");
      closeSession(s);
    }
  }
}, 60_000);

const app = express();
// CORS is configurable via CORS_ALLOWED_ORIGINS (comma-separated). If unset/empty,
// keep the current permissive behavior (reflect any origin) so nothing breaks;
// if set, restrict to the allowlist while still permitting no-origin requests.
function corsFromEnv() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return cors({ origin: true });
  const allow = new Set(raw);
  return cors({
    origin(origin, cb) {
      if (!origin || allow.has(origin)) return cb(null, true);
      cb(null, false);
    },
  });
}
app.use(corsFromEnv());
app.use(express.json({ limit: "64kb" }));

app.get("/api/v1/playground/health", (_req, res) => {
  res.json({ status: "ok", service: "playground-agent", sessions: sessions.size, model: config.openrouterModel });
});

// Start a sandboxed session: verify Turnstile, hand out a funded testnet wallet,
// spawn its MCP server.
app.post("/api/v1/playground/session", async (req: Request, res: Response) => {
  const { turnstileToken } = (req.body ?? {}) as { turnstileToken?: string };
  const ip = (req.headers["x-real-ip"] as string) || req.ip;
  if (!(await verifyTurnstile(turnstileToken ?? "", ip))) {
    return res.status(403).json({ error: "captcha_failed" });
  }
  if (sessions.size >= config.maxSessions) {
    return res.status(429).json({ error: "playground_busy", detail: "Too many active sessions. Try again shortly." });
  }

  try {
    const wallet = await acquireWallet();
    const id = randomUUID();

    const mcp = new McpSession(wallet.secret);
    await mcp.connect();

    const targets: Record<TargetKey, Target> = {
      demosdk: { url: config.demoSdkUrl, label: "demo-sdk-next.verivyx.com — a real Verivyx SDK-protected site" },
      webtest: { url: config.webTestUrl, label: "web-test.verivyx.com — a real Verivyx-protected WordPress post" },
    };

    const session: Session = {
      id,
      wallet,
      mcp,
      targets,
      activeTarget: "demosdk",
      messages: [{ role: "system", content: systemPrompt(targets.demosdk.url, targets.demosdk.label) }],
      createdAt: Date.now(),
      lastUsed: Date.now(),
      busy: false,
    };
    sessions.set(id, session);

    const balances = await walletBalances(wallet.publicKey).catch(() => ({ usdc: "?", xlm: "?" }));
    log.info({ session: id, wallet: wallet.publicKey }, "session started");
    res.json({
      sessionId: id,
      walletAddress: wallet.publicKey,
      balances,
      targets: { demosdk: targets.demosdk.label, webtest: targets.webtest.label },
      network: "stellar:testnet",
      model: config.openrouterModel,
    });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : e }, "session start failed");
    res.status(500).json({ error: "session_start_failed", detail: e instanceof Error ? e.message : "" });
  }
});

// Chat turn → SSE stream of agent + payment events.
app.post("/api/v1/playground/chat", async (req: Request, res: Response) => {
  const { sessionId, message, target } = (req.body ?? {}) as {
    sessionId?: string;
    message?: string;
    target?: TargetKey;
  };
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) return res.status(404).json({ error: "session_not_found" });
  if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "empty_message" });
  if (session.busy) return res.status(409).json({ error: "session_busy" });

  // Switch the target (demo-sdk ↔ web-test) when the UI selects a different one. The
  // system prompt is rebuilt so the agent only ever knows the active target URL.
  if ((target === "demosdk" || target === "webtest") && target !== session.activeTarget) {
    session.activeTarget = target;
    const t = session.targets[target];
    session.messages[0] = { role: "system", content: systemPrompt(t.url, t.label) };
  }

  session.busy = true;
  session.lastUsed = Date.now();
  session.messages.push({ role: "user", content: message.slice(0, 2000) });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    await runAgentTurn(session.mcp, session.messages, send);
    // Attach fresh balances after the turn.
    const balances = await walletBalances(session.wallet.publicKey).catch(() => null);
    if (balances) res.write(`data: ${JSON.stringify({ type: "balances", balances })}\n\n`);
  } catch (e) {
    send({ type: "error", message: e instanceof Error ? e.message : "agent error" });
  } finally {
    session.busy = false;
    session.lastUsed = Date.now();
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

app.listen(config.port, async () => {
  log.info(
    { port: config.port, model: config.openrouterModel, faucet: faucetAddress(), demoSdk: config.demoSdkUrl },
    "playground-agent listening",
  );
  try {
    log.info({ faucetUsdc: await faucetUsdcBalance() }, "faucet balance");
  } catch {
    /* ignore */
  }
  startWalletPool();
});
