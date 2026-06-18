import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { payloadHash, settleOnce, _resetIdempotency } from '../src/idempotency';

beforeEach(() => {
  _resetIdempotency();
});

test('payloadHash is deterministic for same input', () => {
  const xdr = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.equal(payloadHash(xdr), payloadHash(xdr));
});

test('payloadHash differs for different inputs', () => {
  assert.notEqual(payloadHash('aaa'), payloadHash('bbb'));
});

test('payloadHash returns a 64-char hex string', () => {
  const h = payloadHash('some-tx-xdr');
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('settleOnce: fn runs once, second call returns cached result', async () => {
  let calls = 0;
  const fn = async () => { calls++; return 'result-A'; };

  const r1 = await settleOnce('key1', fn);
  const r2 = await settleOnce('key1', fn);

  assert.equal(r1, 'result-A');
  assert.equal(r2, 'result-A');
  assert.equal(calls, 1, 'fn should run exactly once for repeated sequential calls');
});

test('settleOnce: two concurrent calls coalesce to a single fn execution', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    // small delay to ensure both calls overlap in-flight
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    return 'concurrent-result';
  };

  const [r1, r2] = await Promise.all([settleOnce('key2', fn), settleOnce('key2', fn)]);

  assert.equal(r1, 'concurrent-result');
  assert.equal(r2, 'concurrent-result');
  assert.equal(calls, 1, 'fn should run exactly once for concurrent calls');
});

test('settleOnce: rejection is not cached — subsequent call retries fn', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new Error('transient failure');
    return 'success-after-retry';
  };

  await assert.rejects(settleOnce('key3', fn), /transient failure/);
  assert.equal(calls, 1, 'fn should have been called once before the rejection');

  const r = await settleOnce('key3', fn);
  assert.equal(r, 'success-after-retry');
  assert.equal(calls, 2, 'fn should have been called again after rejection (not cached)');
});

test('settleOnce: different keys each run fn independently', async () => {
  let callsA = 0;
  let callsB = 0;
  const fnA = async () => { callsA++; return 'A'; };
  const fnB = async () => { callsB++; return 'B'; };

  const [rA, rB] = await Promise.all([settleOnce('keyA', fnA), settleOnce('keyB', fnB)]);

  assert.equal(rA, 'A');
  assert.equal(rB, 'B');
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
});

test('settleOnce: completed cache entry expires after ttlMs, allowing fn to run again', async () => {
  let calls = 0;
  const fn = async () => { calls++; return `result-${calls}`; };

  // First call — fn runs, result is cached with a 20ms TTL.
  const r1 = await settleOnce('ttl-key', fn, 20);
  assert.equal(r1, 'result-1');
  assert.equal(calls, 1);

  // Second call within TTL — returns cached result without calling fn.
  const r2 = await settleOnce('ttl-key', fn, 20);
  assert.equal(r2, 'result-1');
  assert.equal(calls, 1, 'fn must not run again while cache entry is fresh');

  // Wait past the TTL so the cache entry expires.
  await new Promise<void>(resolve => setTimeout(resolve, 30));

  // Third call after TTL — cache entry expired, fn must run again.
  const r3 = await settleOnce('ttl-key', fn, 20);
  assert.equal(r3, 'result-2');
  assert.equal(calls, 2, 'fn must run again after cache TTL expires (completedCache.delete branch)');
});
