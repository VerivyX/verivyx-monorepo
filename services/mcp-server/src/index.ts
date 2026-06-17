import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { requireInternalToken, requireMcpKey } from "./auth.js";
import { dnsRebindingGuard } from "./dnsGuard.js";
import { createPaymentService } from "./chains/payments.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildMcpServer } from "./mcp/server.js";

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

  // Per-session transports for the Streamable HTTP MCP endpoint.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", dnsRebindingGuard, requireMcpKey, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      // Internal per-session wallet override (e.g. the playground pool). Gated by
      // the same API key; pays from the caller's session wallet, Stellar-only.
      const sessionSecret = (req.headers["x-session-stellar-secret"] as string | undefined)?.trim();
      const sessionPayments = sessionSecret
        ? await createPaymentService({ stellarSecretKey: sessionSecret, stellarOnly: true })
        : payments;
      const server = buildMcpServer(sessionPayments);
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
    await transports[sessionId].handleRequest(req, res);
  };

  app.get("/mcp", dnsRebindingGuard, requireMcpKey, handleSessionRequest);
  app.delete("/mcp", dnsRebindingGuard, requireMcpKey, handleSessionRequest);

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
