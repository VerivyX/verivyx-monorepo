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
