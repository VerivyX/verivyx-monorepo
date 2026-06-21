import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response, type RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";

import { requireInternalToken, requireMcpAuth, requireUserAuth } from "./auth.js";
import { createPaymentService } from "./chains/payments.js";
import { chooseStellarPaymentMode } from "./chains/routing.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildMcpServer } from "./mcp/server.js";
import { buildProtectedResourceMetadata } from "./oauth.js";
import { buildWalletRouter } from "./wallet/endpoints.js";
import {
  bindWallet,
  deleteBinding,
  getBinding,
  getWalletStatus,
  isEarlyAccessGranted,
  upsertBinding,
} from "./wallet/registry.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  const payments = await createPaymentService();

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(
    cors({
      // Browser MCP clients need to read the session id; server-side clients ignore CORS.
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "Mcp-Session-Id", "X-Verivyx-MCP-Key", "Authorization"],
    }),
  );

  // Build the host-guard middleware for the /mcp endpoint (DNS-rebinding defence).
  // Strip any ":port" suffix from cfg.allowedHosts so hostHeaderValidation receives
  // bare hostnames (IPv6 brackets preserved, e.g. "[::1]").
  const hostGuard: RequestHandler = cfg.allowedHosts.includes("*")
    ? (_req, _res, next) => next()
    : hostHeaderValidation(
        [...new Set(
          cfg.allowedHosts.map(h => {
            // IPv6 with port: "[::1]:8088" → "[::1]"
            const ipv6Match = /^(\[.+\])(?::\d+)?$/.exec(h);
            if (ipv6Match) return ipv6Match[1];
            // IPv4/hostname with port: "127.0.0.1:8088" → "127.0.0.1"
            const colonIdx = h.lastIndexOf(":");
            return colonIdx !== -1 ? h.slice(0, colonIdx) : h;
          }),
        )],
      );

  // Serve RFC 9728 Protected Resource Metadata when Hydra OAuth is configured.
  if (cfg.oauth) {
    app.get("/.well-known/oauth-protected-resource", (_req, res) => {
      res.json(buildProtectedResourceMetadata(cfg.oauth!.resourceUri, cfg.oauth!.issuer));
    });
  }

  // Per-session transports for the Streamable HTTP MCP endpoint.
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const lastSeen: Record<string, number> = {};
  // Session owner binding: maps sessionId → owner identity string.
  const owners: Record<string, string> = {};

  /** Derive a stable owner identity string from the authenticated request. */
  function ownerId(req: Request): string {
    const u = (req as Request & { mcpUser?: { kind: "oauth"; sub: string } | { kind: "key"; label: string } }).mcpUser;
    if (u?.kind === "oauth") return `oauth:${u.sub}`;
    return `key:${u?.kind === "key" ? u.label : "unknown"}`;
  }

  // Evict sessions idle longer than MCP_SESSION_TTL_MS (default 30 min).
  const SESSION_TTL_MS = Number(process.env["MCP_SESSION_TTL_MS"]) || (30 * 60_000);
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const id of Object.keys(transports)) {
      if ((lastSeen[id] ?? 0) < cutoff) {
        logger.info({ sessionId: id }, "mcp session evicted (idle TTL)");
        transports[id].close();
        delete transports[id];
        delete lastSeen[id];
        delete owners[id];
      }
    }
  }, 60_000);
  // Don't hold the process open if it would otherwise exit cleanly.
  sweepInterval.unref();

  app.post("/mcp", hostGuard, requireMcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Validate session ownership to prevent session hijacking.
      if (owners[sessionId] !== undefined && owners[sessionId] !== ownerId(req)) {
        res.status(403).json({ error: "session_owner_mismatch" });
        return;
      }
      transport = transports[sessionId];
      lastSeen[sessionId] = Date.now();
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const reqOwnerId = ownerId(req);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          transports[id] = transport;
          lastSeen[id] = Date.now();
          owners[id] = reqOwnerId;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete lastSeen[transport.sessionId];
          delete owners[transport.sessionId];
        }
      };
      // Choose the per-request payment service. OAuth callers pay non-custodially
      // from their own linked wallet; static-key callers keep the legacy paths
      // (playground per-session override via x-session-stellar-secret, else the
      // custodial MCP wallet). See chooseStellarPaymentMode for all branches.
      const sessionSecret = (req.headers["x-session-stellar-secret"] as string | undefined)?.trim();
      const mcpUser = (req as Request & {
        mcpUser?: { kind: "oauth"; sub: string } | { kind: "key"; label: string };
      }).mcpUser;

      // OAuth callers: look up their wallet binding (impure). getBinding throws if
      // MCP_WALLET_ENC_KEY is unset → treat as "no binding" and fall back safely so
      // the request never crashes.
      let hasBinding = false;
      let binding: Awaited<ReturnType<typeof getBinding>> = null;
      if (mcpUser?.kind === "oauth") {
        try {
          binding = await getBinding(mcpUser.sub);
          hasBinding = binding !== null;
        } catch (error) {
          logger.warn(
            { err: String(error), sub: mcpUser.sub },
            "wallet binding lookup failed; treating caller as no_wallet_linked",
          );
          hasBinding = false;
        }
      }

      const mode = chooseStellarPaymentMode(mcpUser, hasBinding, !!sessionSecret);

      let sessionPayments;
      switch (mode) {
        case "noncustodial":
          sessionPayments = await createPaymentService({
            nonCustodial: {
              smartAccountId: binding!.smartAccount,
              sessionSecret: binding!.sessionSignerSecret,
            },
          });
          break;
        case "no_wallet_linked":
          sessionPayments = await createPaymentService({ noWalletLinked: true });
          break;
        case "session_override":
          sessionPayments = await createPaymentService({
            stellarSecretKey: sessionSecret,
            stellarOnly: true,
          });
          break;
        case "custodial":
        default:
          sessionPayments = payments;
          break;
      }
      const server = buildMcpServer(sessionPayments, { isNonCustodial: mode === "noncustodial" });
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    // Validate session ownership.
    if (owners[sessionId] !== undefined && owners[sessionId] !== ownerId(req)) {
      res.status(403).json({ error: "session_owner_mismatch" });
      return;
    }
    lastSeen[sessionId] = Date.now();
    await transports[sessionId].handleRequest(req, res);
  };

  app.get("/mcp", hostGuard, requireMcpAuth, handleSessionRequest);
  app.delete("/mcp", hostGuard, requireMcpAuth, handleSessionRequest);

  // Wallet lifecycle endpoints (Plan 3 T1): session-signer, binding, status, revoke.
  // Mounted behind requireUserAuth which accepts Hydra OAuth JWTs (agents) OR the
  // dashboard auth-service HS256 token (browser). Static API keys are rejected (403).
  // Note: cfg.oauth is not required — dashboard auth alone is sufficient when
  // HYDRA_ISSUER is unset but JWT_SECRET is set. Mount unconditionally so the
  // dashboard path always works; requireUserAuth returns 401 when neither secret
  // is configured.
  {
    const walletRouter = buildWalletRouter({
      getBinding,
      getWalletStatus,
      isEarlyAccessGranted,
      upsertBinding,
      bindWallet: (sub, smartAccount, budgetAtomic, expiryLedger) =>
        bindWallet(sub, smartAccount, budgetAtomic, expiryLedger),
      deleteBinding,
    });
    app.use("/wallet", requireUserAuth, walletRouter);
    logger.info("wallet endpoints mounted at /wallet (Hydra OAuth or dashboard token)");
  }

  // Liveness — no secrets.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "mcp-server", chains: payments.supportedChains() });
  });

  // Internal admin overview (auth-service proxies this for the admin console).
  app.get("/admin/overview", requireInternalToken, (_req, res) => {
    res.json({
      serviceFee: cfg.feeUsdc,
      mainnetEnabled: cfg.mainnetEnabled,
      apiKeysConfigured: cfg.apiKeys.length,
      chains: payments.supportedChains(),
      wallets: payments.info(),
    });
  });

  app.listen(cfg.port, () => {
    logger.info({ port: cfg.port, chains: payments.supportedChains() }, "verivyx mcp-server listening");
  });
}

main().catch(error => {
  logger.error({ err: String(error) }, "fatal: mcp-server failed to start");
  process.exit(1);
});
