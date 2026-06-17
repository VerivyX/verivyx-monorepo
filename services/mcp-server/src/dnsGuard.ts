import type { NextFunction, Request, Response } from "express";

import { getConfig } from "./config.js";

export type GuardResult = { ok: true } | { ok: false; reason: "host_not_allowed" | "origin_not_allowed" };

/**
 * Pure DNS-rebinding / cross-origin check for the /mcp endpoint.
 *
 * - Host: if `allowedHosts` is set (and not "*"), the request Host must be in it.
 *   This stops DNS-rebinding, where an attacker page resolves their domain to a
 *   victim MCP server's IP and drives it from the browser.
 * - Origin: only checked when an Origin header is present (non-browser agents
 *   omit it). If `allowedOrigins` is set (and not "*"), the Origin must be in it.
 *
 * Comparisons are case-insensitive; callers pass already-lowercased allowlists.
 */
export function checkRequestOrigin(
  host: string | undefined,
  origin: string | undefined,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): GuardResult {
  const hostsActive = allowedHosts.length > 0 && !allowedHosts.includes("*");
  if (hostsActive) {
    const h = (host ?? "").toLowerCase();
    if (!h || !allowedHosts.includes(h)) return { ok: false, reason: "host_not_allowed" };
  }

  const originsActive = allowedOrigins.length > 0 && !allowedOrigins.includes("*");
  if (originsActive && origin) {
    if (!allowedOrigins.includes(origin.toLowerCase())) return { ok: false, reason: "origin_not_allowed" };
  }

  return { ok: true };
}

/** Express middleware wrapper around checkRequestOrigin for the /mcp routes. */
export function dnsRebindingGuard(req: Request, res: Response, next: NextFunction): void {
  const { allowedHosts, allowedOrigins } = getConfig();
  const result = checkRequestOrigin(req.headers.host, req.headers.origin, allowedHosts, allowedOrigins);
  if (!result.ok) {
    // 421 Misdirected Request fits a Host mismatch; 403 for a disallowed Origin.
    const status = result.reason === "host_not_allowed" ? 421 : 403;
    res.status(status).json({ error: result.reason });
    return;
  }
  next();
}
