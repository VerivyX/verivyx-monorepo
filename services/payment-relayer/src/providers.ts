import Redis from 'ioredis';
import { LockProvider, InMemoryLock, RedisLock, RedisLike } from './lock.js';
import { IdempotencyProvider, InMemoryIdempotency, RedisIdempotency } from './idempotency.js';

export type RelayerMode = 'memory' | 'redis';

export interface Providers {
  lock: LockProvider;
  idempotency: IdempotencyProvider;
  mode: RelayerMode;
}

/**
 * Resolve the configured Redis URL. RELAYER_REDIS_URL wins, then REDIS_URL.
 * Unset/empty → undefined → in-memory (single-instance) providers.
 */
export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = (env.RELAYER_REDIS_URL || env.REDIS_URL || '').trim();
  return url || undefined;
}

/** Default Redis client: created ONLY when a URL is configured. */
function defaultMakeRedis(url: string): RedisLike {
  return new Redis(url, { maxRetriesPerRequest: null }) as unknown as RedisLike;
}

/**
 * Pick the lock + idempotency implementations from the environment.
 *  - No Redis URL  → InMemoryLock + InMemoryIdempotency (DEFAULT, unchanged).
 *  - Redis URL set → RedisLock + RedisIdempotency (multi-instance safe).
 * `makeRedis` is injectable for tests so selection can be verified without a
 * live server.
 */
export function createProviders(
  env: NodeJS.ProcessEnv = process.env,
  makeRedis: (url: string) => RedisLike = defaultMakeRedis,
): Providers {
  const url = resolveRedisUrl(env);
  if (!url) {
    return { lock: new InMemoryLock(), idempotency: new InMemoryIdempotency(), mode: 'memory' };
  }
  const redis = makeRedis(url);
  return { lock: new RedisLock(redis), idempotency: new RedisIdempotency(redis), mode: 'redis' };
}
