import assert from 'node:assert/strict';
import { test } from 'node:test';
import RedisMock from 'ioredis-mock';
import { RedisLock, InMemoryLock, _RELEASE_SCRIPT, RedisLike } from '../src/lock.js';

const KEY = 'verivyx:relayer:facilitator-lock';
const mkRedis = () => new RedisMock() as unknown as RedisLike & { pttl: (k: string) => Promise<number> };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('InMemoryLock serializes overlapping runs (no interleave)', async () => {
  const lock = new InMemoryLock();
  const log: string[] = [];
  const a = lock.run(async () => { log.push('a-start'); await sleep(30); log.push('a-end'); });
  const b = lock.run(async () => { log.push('b-start'); await sleep(5); log.push('b-end'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('RedisLock serializes across two instances sharing one redis (second waits)', async () => {
  const redis = mkRedis();
  const lockA = new RedisLock(redis, { ttlMs: 5000, retryDelayMs: 5 });
  const lockB = new RedisLock(redis, { ttlMs: 5000, retryDelayMs: 5 });
  const log: string[] = [];
  const a = lockA.run(async () => { log.push('a-start'); await sleep(60); log.push('a-end'); });
  // Give A a beat to acquire first, then B must wait until A releases.
  await sleep(10);
  const b = lockB.run(async () => { log.push('b-start'); await sleep(5); log.push('b-end'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('RedisLock sets a TTL on the key while held', async () => {
  const redis = mkRedis();
  const ttlMs = 90_000;
  const lock = new RedisLock(redis, { ttlMs });
  let pttlSeen = -1;
  await lock.run(async () => { pttlSeen = await redis.pttl(KEY); });
  assert.ok(pttlSeen > 0, `expected positive pttl while held, got ${pttlSeen}`);
  assert.ok(pttlSeen <= ttlMs, `pttl ${pttlSeen} should not exceed ttl ${ttlMs}`);
});

test('RedisLock releases the key after run completes', async () => {
  const redis = mkRedis();
  const lock = new RedisLock(redis);
  await lock.run(async () => {});
  assert.equal(await redis.get(KEY), null, 'lock key must be cleared after run');
});

test('RedisLock release on throw frees the lock for the next acquirer', async () => {
  const redis = mkRedis();
  const lock = new RedisLock(redis, { retryDelayMs: 5 });
  await assert.rejects(lock.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await redis.get(KEY), null, 'lock must be released even when fn throws');
  let ran = false;
  await lock.run(async () => { ran = true; });
  assert.equal(ran, true);
});

test('RedisLock does NOT release a key it no longer holds (token compare)', async () => {
  const redis = mkRedis();
  const lock = new RedisLock(redis, { ttlMs: 5000 });
  // Simulate the lock expiring mid-run and a peer re-acquiring it.
  await lock.run(async () => { await redis.set(KEY, 'peer-token'); });
  assert.equal(await redis.get(KEY), 'peer-token', 'must not delete a peer-owned lock');
});

test('release Lua script only deletes when the token matches', async () => {
  const redis = mkRedis();
  await redis.set('lk', 'tokenX');
  const wrong = await redis.eval(_RELEASE_SCRIPT, 1, 'lk', 'nope');
  assert.equal(wrong, 0);
  assert.equal(await redis.get('lk'), 'tokenX', 'wrong token must not delete');
  const right = await redis.eval(_RELEASE_SCRIPT, 1, 'lk', 'tokenX');
  assert.equal(right, 1);
  assert.equal(await redis.get('lk'), null, 'matching token must delete');
});
