import { createHash, randomBytes } from 'crypto';
import type { RedisLike } from './lock.js';

// sha256 hex of the signed transaction XDR — the server-derived dedupe key
export function payloadHash(transactionXdr: string): string {
  return createHash('sha256').update(transactionXdr).digest('hex');
}

// Sentinel for intentional 400 validation failures inside settleOnce.
// Using instanceof instead of an unguarded statusCode cast prevents third-party
// errors (e.g. from the Stellar SDK) that happen to carry statusCode: 400 from
// being misrouted as client errors.
export class SettleValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SettleValidationError';
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Dedupe + coalesce settle work by key. Implementations must:
 *  - return a cached result when one exists within TTL (fn does NOT run again),
 *  - coalesce concurrent identical calls so fn runs once,
 *  - NOT cache rejections (including SettleValidationError) — only successes.
 * The contract is identical for in-memory and Redis so call sites never change.
 */
export interface IdempotencyProvider {
  settleOnce<T>(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T>;
}

type CompletedEntry = { result: unknown; expiresAt: number };

/**
 * Single-instance default. Completed-result cache (24h TTL) + in-flight
 * coalescing, both held in process memory. Byte-for-byte the original behavior.
 */
export class InMemoryIdempotency implements IdempotencyProvider {
  private readonly completedCache = new Map<string, CompletedEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  settleOnce<T>(key: string, fn: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
    // Check completed cache
    const cached = this.completedCache.get(key);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        return Promise.resolve(cached.result as T);
      }
      this.completedCache.delete(key);
    }

    // Check in-flight
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    // Start new call
    const promise: Promise<T> = fn().then(
      (result) => {
        this.completedCache.set(key, { result, expiresAt: Date.now() + ttlMs });
        this.inFlight.delete(key);
        return result;
      },
      (err) => {
        this.inFlight.delete(key);
        throw err;
      },
    );

    this.inFlight.set(key, promise as Promise<unknown>);
    return promise;
  }

  // Test-only reset hook so unit tests start with a clean slate.
  reset(): void {
    this.completedCache.clear();
    this.inFlight.clear();
  }
}

export interface RedisIdempotencyOptions {
  keyPrefix?: string;
  inflightPrefix?: string;
  /**
   * TTL of the in-flight marker. MUST cover one full settle (submit+distribute)
   * so a peer instance can't re-submit while the owner is still working.
   */
  markerTtlMs?: number;
  /** Backoff while waiting for a peer instance to publish its result. */
  pollDelayMs?: number;
}

const RELEASE_MARKER_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function newToken(): string {
  return randomBytes(16).toString('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-instance dedupe. Completed results are cached in Redis (24h TTL); an
 * NX marker coalesces in-flight settles across instances so two relayers can't
 * double-submit the same tx. Local in-flight map additionally coalesces within
 * one instance. Rejections (incl. SettleValidationError) are never cached — only
 * successful results are written, so validation failures always re-run.
 */
export class RedisIdempotency implements IdempotencyProvider {
  private readonly redis: RedisLike;
  private readonly keyPrefix: string;
  private readonly inflightPrefix: string;
  private readonly markerTtlMs: number;
  private readonly pollDelayMs: number;
  private readonly localInFlight = new Map<string, Promise<unknown>>();

  constructor(redis: RedisLike, opts: RedisIdempotencyOptions = {}) {
    this.redis = redis;
    this.keyPrefix = opts.keyPrefix ?? 'verivyx:relayer:settle:';
    this.inflightPrefix = opts.inflightPrefix ?? 'verivyx:relayer:settle-inflight:';
    this.markerTtlMs = opts.markerTtlMs ?? 90_000;
    this.pollDelayMs = opts.pollDelayMs ?? 50;
  }

  settleOnce<T>(key: string, fn: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
    const local = this.localInFlight.get(key);
    if (local) return local as Promise<T>;

    const promise = this.resolve<T>(key, fn, ttlMs);
    this.localInFlight.set(key, promise as Promise<unknown>);
    // Clear the local coalescing slot on both success and failure.
    void promise.then(
      () => this.localInFlight.delete(key),
      () => this.localInFlight.delete(key),
    );
    return promise;
  }

  private async resolve<T>(key: string, fn: () => Promise<T>, ttlMs: number): Promise<T> {
    const cacheKey = this.keyPrefix + key;
    const markerKey = this.inflightPrefix + key;

    for (;;) {
      // 1. Completed-result cache.
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as T;
      }

      // 2. Claim the in-flight marker. Winner runs fn; everyone else waits.
      const token = newToken();
      const claimed = await this.redis.set(markerKey, token, 'PX', this.markerTtlMs, 'NX');
      if (claimed === 'OK') {
        try {
          const result = await fn();
          // Only successes are cached. A throw (incl. SettleValidationError)
          // skips this and re-runs on the next call.
          await this.redis.set(cacheKey, JSON.stringify(result), 'PX', ttlMs);
          return result;
        } finally {
          await this.releaseMarker(markerKey, token);
        }
      }

      // 3. A peer owns the marker. Wait for its result, then loop: either the
      //    cache is populated (success) or the marker is gone (peer failed) and
      //    we re-claim.
      await sleep(this.pollDelayMs);
    }
  }

  private async releaseMarker(markerKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_MARKER_SCRIPT, 1, markerKey, token);
    } catch {
      // Best-effort; the marker TTL guarantees it eventually frees.
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible module-level API (default single-instance behavior).
// Existing call sites and tests use these directly; they delegate to a shared
// InMemoryIdempotency instance so behavior is unchanged.
// ---------------------------------------------------------------------------
const defaultInMemory = new InMemoryIdempotency();

export function settleOnce<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  return defaultInMemory.settleOnce(key, fn, ttlMs);
}

// Test-only reset hook so unit tests start with a clean slate.
export function _resetIdempotency(): void {
  defaultInMemory.reset();
}
