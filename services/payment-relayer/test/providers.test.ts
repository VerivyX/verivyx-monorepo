import assert from 'node:assert/strict';
import { test } from 'node:test';
import RedisMock from 'ioredis-mock';
import { createProviders, resolveRedisUrl } from '../src/providers.js';
import { InMemoryLock, RedisLock, RedisLike } from '../src/lock.js';
import { InMemoryIdempotency, RedisIdempotency } from '../src/idempotency.js';

const fakeMakeRedis = () => new RedisMock() as unknown as RedisLike;

test('resolveRedisUrl: unset/empty/whitespace → undefined', () => {
  assert.equal(resolveRedisUrl({}), undefined);
  assert.equal(resolveRedisUrl({ RELAYER_REDIS_URL: '' }), undefined);
  assert.equal(resolveRedisUrl({ REDIS_URL: '   ' }), undefined);
});

test('resolveRedisUrl: RELAYER_REDIS_URL wins, REDIS_URL is fallback', () => {
  assert.equal(resolveRedisUrl({ RELAYER_REDIS_URL: 'redis://a', REDIS_URL: 'redis://b' }), 'redis://a');
  assert.equal(resolveRedisUrl({ REDIS_URL: 'redis://b' }), 'redis://b');
});

test('createProviders: no Redis URL → in-memory providers (default)', () => {
  const p = createProviders({}, fakeMakeRedis);
  assert.equal(p.mode, 'memory');
  assert.ok(p.lock instanceof InMemoryLock);
  assert.ok(p.idempotency instanceof InMemoryIdempotency);
});

test('createProviders: RELAYER_REDIS_URL set → Redis providers', () => {
  const p = createProviders({ RELAYER_REDIS_URL: 'redis://x:6379' }, fakeMakeRedis);
  assert.equal(p.mode, 'redis');
  assert.ok(p.lock instanceof RedisLock);
  assert.ok(p.idempotency instanceof RedisIdempotency);
});

test('createProviders: REDIS_URL fallback also selects Redis providers', () => {
  const p = createProviders({ REDIS_URL: 'redis://x:6379' }, fakeMakeRedis);
  assert.equal(p.mode, 'redis');
  assert.ok(p.lock instanceof RedisLock);
  assert.ok(p.idempotency instanceof RedisIdempotency);
});
