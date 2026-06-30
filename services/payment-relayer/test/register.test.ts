import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRegisterArgs } from '../src/register-args.js';

test('converts USDC to atomic i128 strings', () => {
  assert.deepEqual(toRegisterArgs({ price: 0.03, platformFee: 0.001 }), { priceAtomic: 300000n, feeAtomic: 10000n });
});
test('rejects fee >= price', () => {
  assert.throws(() => toRegisterArgs({ price: 0.001, platformFee: 0.001 }), /invalid_price/);
});
test('rejects price <= 0', () => {
  assert.throws(() => toRegisterArgs({ price: 0, platformFee: 0 }), /invalid_price/);
});
test('rejects negative fee', () => {
  assert.throws(() => toRegisterArgs({ price: 0.03, platformFee: -0.001 }), /invalid_price/);
});
