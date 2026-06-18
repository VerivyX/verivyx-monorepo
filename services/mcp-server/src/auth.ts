import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { matchApiKey } from "./apiKeys.js";
import { getConfig } from "./config.js";

const MCP_KEY_HEADER = "x-verivyx-mcp-key";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Gate the public MCP endpoint behind a Verivyx-issued API key allowlist.
 * While the public UI is coming-soon, only internal/playground/test callers
 * (which hold a key) can reach the MCP tools.
 */
export function requireMcpKey(req: Request, res: Response, next: NextFunction): void {
  const presented =
    (req.header(MCP_KEY_HEADER) ?? req.header("authorization")?.replace(/^Bearer\s+/i, ""))?.trim() ??
    "";

  const { apiKeys } = getConfig();
  if (apiKeys.length === 0) {
    res.status(503).json({ error: "mcp_disabled", message: "No MCP API keys configured." });
    return;
  }
  const label = matchApiKey(presented, apiKeys);
  if (!presented || label === null) {
    res.status(401).json({ error: "unauthorized", message: "Valid X-Verivyx-MCP-Key required." });
    return;
  }
  (req as Request & { mcpKeyLabel?: string }).mcpKeyLabel = label;
  next();
}

/** Internal-only endpoints (admin proxy / health detail) require X-Internal-Token. */
export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const presented = req.header("x-internal-token")?.trim() ?? "";
  if (!presented || !safeEqual(presented, getConfig().internalToken)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
