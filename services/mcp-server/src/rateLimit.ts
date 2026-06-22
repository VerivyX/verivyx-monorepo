/**
 * In-memory rate limiting for the MCP server.
 *
 * Single-instance (one mcp-server container) → a process-local Map is sufficient.
 * NOTE: if the MCP server is ever scaled horizontally, replace the Map with a
 * shared store (e.g. Redis) so limits hold across instances.
 *
 * Pattern mirrors auth-service's rateLimit() — a fixed-window counter per key.
 */
import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Opportunistic cleanup so the Map doesn't grow unbounded with stale keys.
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
  }
}

/**
 * Returns true if the action is allowed (under the limit), false if it should be
 * rejected. Fixed window of `windowMs`, at most `max` hits per window per key.
 */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

/** Best-effort client IP (mcp-server runs behind nginx, which sets X-Real-IP). */
export function clientIp(req: Request): string {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  const fwd = req.headers["x-forwarded-for"];
  const fwdStr = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof fwdStr === "string" && fwdStr.trim()) return fwdStr.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/** The authenticated caller identity, if requireMcpAuth/requireUserAuth ran first. */
function callerId(req: Request): string | undefined {
  const u = (req as Request & {
    mcpUser?: { kind: "oauth"; sub: string } | { kind: "key"; label: string };
  }).mcpUser;
  if (!u) return undefined;
  return u.kind === "oauth" ? `sub:${u.sub}` : `key:${u.label}`;
}

function tooMany(res: Response): void {
  res.status(429).json({ error: "rate_limited", detail: "Too many requests. Please slow down." });
}

/**
 * Per-IP limiter — place BEFORE auth as a cheap DoS guard (covers unauthenticated
 * floods + multiple users behind one NAT generously).
 */
export function ipLimiter(max: number, windowMs: number, name: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!rateLimit(`ip:${name}:${clientIp(req)}`, max, windowMs)) {
      tooMany(res);
      return;
    }
    next();
  };
}

/**
 * Per-authenticated-user limiter — place AFTER requireMcpAuth/requireUserAuth so
 * the key is the caller's identity (sub/label); falls back to IP if unauthenticated.
 */
export function userLimiter(max: number, windowMs: number, name: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = callerId(req) ?? `ip:${clientIp(req)}`;
    if (!rateLimit(`user:${name}:${id}`, max, windowMs)) {
      tooMany(res);
      return;
    }
    next();
  };
}
