import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { matchApiKey } from "./apiKeys.js";
import { getConfig } from "./config.js";
import { makeTokenVerifier, wwwAuthenticateValue } from "./oauth.js";

const MCP_KEY_HEADER = "x-verivyx-mcp-key";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Build verifier and PRM URL once at module init (only when HYDRA_ISSUER is configured).
const cfg = getConfig();
const verifier = cfg.oauth
  ? makeTokenVerifier({
      jwksUrl: cfg.oauth.jwksUrl,
      issuer: cfg.oauth.issuer,
      audience: cfg.oauth.resourceUri,
    })
  : undefined;
const prmUrl = cfg.oauth
  ? new URL(cfg.oauth.resourceUri).origin + "/.well-known/oauth-protected-resource"
  : "";

/**
 * Dual-auth middleware for the public /mcp endpoint.
 * Accepts EITHER:
 *   1. A Hydra-issued Bearer JWT (Authorization: Bearer <token>) — validated via JWKS.
 *   2. A static Verivyx API key (X-Verivyx-MCP-Key header) — validated via sha256 allowlist.
 * The static-key path keeps the playground working when HYDRA_ISSUER is not set.
 */
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Extract bearer token from Authorization header (case-insensitive).
  const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  // 2. Try JWT validation if we have both a bearer token and a configured verifier.
  if (bearer && verifier) {
    try {
      const claims = await verifier(bearer);
      (req as Request & { mcpUser?: { kind: "oauth"; sub: string } }).mcpUser = {
        kind: "oauth",
        sub: claims.sub,
      };
      next();
      return;
    } catch {
      // Fall through to static key check — an invalid JWT does not immediately 401
      // so a client that sends a malformed token can still use a static key.
    }
  }

  // 3. Try static API key (X-Verivyx-MCP-Key header).
  const staticKey = req.header(MCP_KEY_HEADER)?.trim();
  const { apiKeys } = getConfig();
  if (staticKey) {
    const label = matchApiKey(staticKey, apiKeys);
    if (label !== null) {
      (req as Request & { mcpUser?: { kind: "key"; label: string } }).mcpUser = {
        kind: "key",
        label,
      };
      next();
      return;
    }
  }

  // 4. Neither auth method succeeded.
  if (cfg.oauth) {
    res.set("WWW-Authenticate", wwwAuthenticateValue(prmUrl));
  }
  res.status(401).json({ error: "unauthorized" });
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
