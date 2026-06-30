import assert from 'node:assert/strict';
import { test } from 'node:test';
import RedisMock from 'ioredis-mock';
import { RedisIdempotency, SettleValidationError } from '../src/idempotency.js';
import { RedisLike } from '../src/lock.js';

const mkRedis = () => new RedisMock() as unknown as RedisLike;
const opts = { pollDelayMs: 5, markerTtlMs: 5000 };

test('RedisIdempotency: fn runs once, second call returns cached result', async () => {
  const redis = mkRedis();
  const idem = new RedisIdempotency(redis, opts);
  let calls = 0;
  const fn = async () => { calls++; return { ok: true, n: calls }; };

  const r1 = await idem.settleOnce('k1', fn);
  const r2 = await idem.settleOnce('k1', fn);

  assert.deepEqual(r1, { ok: true, n: 1 });
  assert.deepEqual(r2, { ok: true, n: 1 }, 'second call returns cached result');
  assert.equal(calls, 1, 'fn must run exactly once');
});

test('RedisIdempotency: concurrent calls within one instance coalesce', async () => {
  const redis = mkRedis();
  const idem = new RedisIdempotency(redis, opts);
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 'x'; };

  const [a, b] = await Promise.all([idem.settleOnce('k2', fn), idem.settleOnce('k2', fn)]);

  assert.equal(a, 'x');
  assert.equal(b, 'x');
  assert.equal(calls, 1, 'fn must run once for concurrent identical calls');
});

test('RedisIdempotency: concurrent calls across two instances coalesce (marker)', async () => {
  const redis = mkRedis();
  const idemA = new RedisIdempotency(redis, opts);
  const idemB = new RedisIdempotency(redis, opts);
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return 'shared'; };

  const [a, b] = await Promise.all([idemA.settleOnce('k3', fn), idemB.settleOnce('k3', fn)]);

  assert.equal(a, 'shared');
  assert.equal(b, 'shared');
  assert.equal(calls, 1, 'only one instance may run fn; the other waits and reads the cached result');
});

test('RedisIdempotency: SettleValidationError is NOT cached — fn re-runs', async () => {
  const redis = mkRedis();
  const idem = new RedisIdempotency(redis, opts);
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new SettleValidationError('bad input');
    return 'recovered';
  };

  await assert.rejects(idem.settleOnce('k4', fn), (e: unknown) => e instanceof SettleValidationError);
  assert.equal(calls, 1);

  const r = await idem.settleOnce('k4', fn);
  assert.equal(r, 'recovered');
  assert.equal(calls, 2, 'validation failure must not be cached; fn runs again');
});

test('RedisIdempotency: generic rejection is NOT cached — fn re-runs', async () => {
  const redis = mkRedis();
  const idem = new RedisIdempotency(redis, opts);
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw new Error('transient'); return 'ok'; };

  await assert.rejects(idem.settleOnce('k5', fn), /transient/);
  const r = await idem.settleOnce('k5', fn);
  assert.equal(r, 'ok');
  assert.equal(calls, 2);
});
