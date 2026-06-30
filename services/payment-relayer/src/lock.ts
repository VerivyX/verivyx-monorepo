import { randomBytes } from 'crypto';
import { Mutex } from './mutex.js';

/**
 * A lock that serializes async work. `run(fn)` executes the provided functions
 * such that no two run() bodies overlap. Implementations may be single-process
 * (in-memory) or cross-process (Redis), but the contract is identical so call
 * sites never change.
 */
export interface LockProvider {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Single-instance default. This is the existing FIFO Mutex (src/mutex.ts) with
 * no behavioral change — used whenever no Redis URL is configured.
 */
export class InMemoryLock extends Mutex implements LockProvider {}

/** Minimal subset of an ioredis client used by RedisLock/RedisIdempotency. */
export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Compare-token-and-DEL: only the holder (whose token still matches) may release.
// This prevents instance A from deleting a lock that already expired and was
// re-acquired by instance B.
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newToken(): string {
  return randomBytes(16).toString('hex');
}

export interface RedisLockOptions {
  key?: string;
  /**
   * Lock TTL in ms. MUST exceed the longest possible hold (submit ≤30s +
   * distribute ≤30s) so the lock never expires mid-settle. Default 90_000.
   */
  ttlMs?: number;
  /** Backoff between acquire attempts. */
  retryDelayMs?: number;
  /** Safety cap so a wedged holder can't block forever (the lock TTL itself also frees it). */
  acquireTimeoutMs?: number;
}

/**
 * Cross-instance facilitator lock. All facilitator-account Soroban txs serialize
 * on ONE Redis key, so submit+distribute stay atomic across horizontally-scaled
 * relayer instances (the same guarantee the in-memory Mutex gives a single one).
 *
 * Acquire: `SET key <token> NX PX <ttlMs>` with spin/backoff until owned.
 * Release: Lua compare-token-and-DEL — only the holder releases, run on
 * completion AND on throw, so a failing fn never strands the lock.
 */
export class RedisLock implements LockProvider {
  private readonly redis: RedisLike;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly retryDelayMs: number;
  private readonly acquireTimeoutMs: number;

  constructor(redis: RedisLike, opts: RedisLockOptions = {}) {
    this.redis = redis;
    this.key = opts.key ?? 'verivyx:relayer:facilitator-lock';
    this.ttlMs = opts.ttlMs ?? 90_000;
    this.retryDelayMs = opts.retryDelayMs ?? 25;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 120_000;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const token = newToken();
    await this.acquire(token);
    try {
      return await fn();
    } finally {
      await this.release(token);
    }
  }

  private async acquire(token: string): Promise<void> {
    const start = Date.now();
    for (;;) {
      const ok = await this.redis.set(this.key, token, 'PX', this.ttlMs, 'NX');
      if (ok === 'OK') return;
      if (Date.now() - start > this.acquireTimeoutMs) {
        throw new Error('redis_lock_acquire_timeout');
      }
      await sleep(this.retryDelayMs);
    }
  }

  private async release(token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, this.key, token);
    } catch {
      // Best-effort: if release fails the TTL guarantees the lock eventually frees.
    }
  }
}

export { RELEASE_SCRIPT as _RELEASE_SCRIPT };
