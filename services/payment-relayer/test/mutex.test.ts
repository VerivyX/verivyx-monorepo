import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mutex } from '../src/mutex.js';

test('serializes overlapping runs (no interleave)', async () => {
  const m = new Mutex();
  const log: string[] = [];
  const a = m.run(async () => { log.push('a-start'); await new Promise(r => setTimeout(r, 30)); log.push('a-end'); });
  const b = m.run(async () => { log.push('b-start'); await new Promise(r => setTimeout(r, 5)); log.push('b-end'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('FIFO order across 3 queued runs', async () => {
  const m = new Mutex();
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => m.run(async () => { order.push(n); })));
  assert.deepEqual(order, [1, 2, 3]);
});

test('a throwing fn releases the lock and propagates', async () => {
  const m = new Mutex();
  await assert.rejects(() => m.run(async () => { throw new Error('boom'); }), /boom/);
  let ran = false;
  await m.run(async () => { ran = true; });
  assert.equal(ran, true);
});

test('a throwing fn releases the lock for an ALREADY-QUEUED run', async () => {
  const m = new Mutex();
  const p1 = m.run(async () => { throw new Error('boom'); });
  let ran = false;
  const p2 = m.run(async () => { ran = true; });
  await p1.catch(() => {});
  await p2;
  assert.equal(ran, true);
});

test('run() returns the resolved value of fn', async () => {
  const m = new Mutex();
  assert.equal(await m.run(async () => 42), 42);
});

// Regression for txBadSeq: the legacy settle path holds facilitatorLock across BOTH
// the fee-sponsored submit AND distribute. Model that as a single run() doing two
// sequential facilitator ops, and prove a concurrent facilitator op (e.g. another
// settle's submit, or registerCreatorOnChain) cannot interleave between them and
// advance the shared on-chain sequence.
test('settle holds the lock across submit+distribute (no interleave by a concurrent op)', async () => {
  const m = new Mutex();
  const log: string[] = [];
  const settle = m.run(async () => {
    log.push('submit-start');
    await new Promise(r => setTimeout(r, 30)); // submit landing
    log.push('submit-end');
    log.push('distribute-start');
    await new Promise(r => setTimeout(r, 30)); // distribute landing
    log.push('distribute-end');
  });
  // A concurrent facilitator op queued while the settle is in flight.
  const concurrent = m.run(async () => { log.push('concurrent-op'); });
  await Promise.all([settle, concurrent]);
  // The concurrent op must run strictly AFTER the whole submit+distribute pair,
  // never between submit-end and distribute-start.
  assert.deepEqual(log, [
    'submit-start', 'submit-end', 'distribute-start', 'distribute-end', 'concurrent-op',
  ]);
});
