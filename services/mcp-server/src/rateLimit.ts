/**
 * Rate limiting for the MCP server — pluggable store, in-memory by default.
 *
 * - InMemoryStore (DEFAULT): a process-local fixed-window counter. Sufficient for
 *   a single mcp-server container; behaviour is byte-for-byte the original limiter.
 * - RedisStore (opt-in): a shared fixed-window counter in Redis so limits hold
 *   across horizontally-scaled instances. Selected when MCP_REDIS_URL (or REDIS_URL)
 *   is set. Redis errors FAIL OPEN (allow the request) — rate limiting is an
 *   availability guard, not security-critical, so a Redis blip must not 500 traffic.
 *
 * Call sites (ipLimiter/userLimiter) and their signatures are unchanged; they are
 * just backed by the selected store.
 */
import type { Request, Response, NextFunction } from "express";

import { logger } from "./logger.js";

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
 *
 * This is the original in-memory engine; it is kept exported and unchanged so the
 * single-instance default path is identical (and directly unit-testable).
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

/**
 * A rate-limit store: given a key and a window, decide whether the hit is allowed.
 * Async so a network-backed store (Redis) can be plugged in transparently.
 */
export interface RateLimitStore {
  allow(key: string, max: number, windowMs: number): Promise<boolean>;
}

/** DEFAULT store — wraps the in-memory `rateLimit` engine (same semantics). */
export class InMemoryStore implements RateLimitStore {
  allow(key: string, max: number, windowMs: number): Promise<boolean> {
    return Promise.resolve(rateLimit(key, max, windowMs));
  }
}

/** The minimal Redis client surface this store depends on (ioredis-compatible). */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

/**
 * Shared fixed-window counter in Redis. On the first hit within a window we INCR
 * (creating the key at 1) and set PEXPIRE = windowMs; subsequent hits INCR until
 * the key expires and the window resets. Over `max` → rejected.
 *
 * FAIL OPEN: any Redis error allows the request (logged) rather than blocking.
 */
export class RedisStore implements RateLimitStore {
  constructor(private readonly client: RedisLike) {}

  async allow(key: string, max: number, windowMs: number): Promise<boolean> {
    const k = `rl:${key}`;
    try {
      const count = await this.client.incr(k);
      if (count === 1) await this.client.pexpire(k, windowMs);
      return count <= max;
    } catch (err) {
      logger.warn({ err: String(err), key }, "rate-limit: redis error, failing open (allow)");
      return true;
    }
  }
}

/** Resolve the Redis URL from env (MCP_REDIS_URL preferred, REDIS_URL fallback). */
export function redisUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = (env["MCP_REDIS_URL"] ?? env["REDIS_URL"] ?? "").trim();
  return url || undefined;
}

/** Pure selector: which store mode the current env selects. Default = "memory". */
export function selectStoreMode(env: NodeJS.ProcessEnv = process.env): "memory" | "redis" {
  return redisUrlFromEnv(env) ? "redis" : "memory";
}

/** Mask credentials in a redis URL for safe logging. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return "redis://***";
  }
}

let _store: RateLimitStore | undefined;

/**
 * Initialise the rate-limit store from env (call once at boot). In-memory unless a
 * Redis URL is configured. If Redis client creation fails we fall back to in-memory
 * so the server still starts. Logs the selected mode.
 */
export async function initRateLimitStore(env: NodeJS.ProcessEnv = process.env): Promise<RateLimitStore> {
  const url = redisUrlFromEnv(env);
  if (!url) {
    _store = new InMemoryStore();
    logger.info("rate-limiter: in-memory store (single-instance default)");
    return _store;
  }
  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (err: unknown) => {
      logger.warn({ err: String(err) }, "rate-limiter: redis client error");
    });
    _store = new RedisStore(client as unknown as RedisLike);
    logger.info({ redis: redactUrl(url) }, "rate-limiter: redis store (multi-instance)");
    return _store;
  } catch (err) {
    logger.error(
      { err: String(err) },
      "rate-limiter: redis init failed, falling back to in-memory store",
    );
    _store = new InMemoryStore();
    return _store;
  }
}

/** The active store. Defaults to in-memory if initRateLimitStore() was never called. */
export function getRateLimitStore(): RateLimitStore {
  if (!_store) _store = new InMemoryStore();
  return _store;
}

/** Override the active store (tests). */
export function setRateLimitStore(store: RateLimitStore): void {
  _store = store;
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
    void getRateLimitStore()
      .allow(`ip:${name}:${clientIp(req)}`, max, windowMs)
      .then(allowed => {
        if (allowed) next();
        else tooMany(res);
      })
      // Defensive fail-open: an unexpected store rejection must not block traffic.
      .catch(() => { if (!res.headersSent) next(); });
  };
}

/**
 * Per-authenticated-user limiter — place AFTER requireMcpAuth/requireUserAuth so
 * the key is the caller's identity (sub/label); falls back to IP if unauthenticated.
 */
export function userLimiter(max: number, windowMs: number, name: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = callerId(req) ?? `ip:${clientIp(req)}`;
    void getRateLimitStore()
      .allow(`user:${name}:${id}`, max, windowMs)
      .then(allowed => {
        if (allowed) next();
        else tooMany(res);
      })
      // Defensive fail-open: an unexpected store rejection must not block traffic.
      .catch(() => { if (!res.headersSent) next(); });
  };
}
