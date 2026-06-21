import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  toAtomicUsdc,
  expiryToLedger,
  validateDelegation,
  USDC_DECIMALS,
  LEDGERS_PER_DAY,
} from './delegation.js';

// ── constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('USDC_DECIMALS is 7', () => assert.equal(USDC_DECIMALS, 7));
  it('LEDGERS_PER_DAY is 17280', () => assert.equal(LEDGERS_PER_DAY, 17280));
});

// ── toAtomicUsdc ─────────────────────────────────────────────────────────────

describe('toAtomicUsdc', () => {
  it('"1.5" → 15_000_000n', () =>
    assert.equal(toAtomicUsdc('1.5'), 15_000_000n));

  it('"0.001" → 10_000n', () =>
    assert.equal(toAtomicUsdc('0.001'), 10_000n));

  it('"1" → 10_000_000n (no decimal point)', () =>
    assert.equal(toAtomicUsdc('1'), 10_000_000n));

  it('"0.0000001" → 1n (7 dp, minimum unit)', () =>
    assert.equal(toAtomicUsdc('0.0000001'), 1n));

  it('"100" → 1_000_000_000n', () =>
    assert.equal(toAtomicUsdc('100'), 1_000_000_000n));

  it('"0.1234567" → 1_234_567n (all 7 decimals)', () =>
    assert.equal(toAtomicUsdc('0.1234567'), 1_234_567n));

  // rejection cases
  it('rejects empty string', () =>
    assert.throws(() => toAtomicUsdc(''), /invalid/i));

  it('rejects "-1" (negative)', () =>
    assert.throws(() => toAtomicUsdc('-1'), /negative|invalid/i));

  it('rejects "abc"', () =>
    assert.throws(() => toAtomicUsdc('abc'), /invalid/i));

  it('rejects "1.12345678" (8 decimal places)', () =>
    assert.throws(() => toAtomicUsdc('1.12345678'), /decimal/i));

  it('rejects "1.2.3" (multiple dots)', () =>
    assert.throws(() => toAtomicUsdc('1.2.3'), /invalid/i));

  it('rejects "0" (zero budget)', () =>
    assert.throws(() => toAtomicUsdc('0'), /zero|positive|invalid/i));

  it('rejects "0.0" (zero budget decimal)', () =>
    assert.throws(() => toAtomicUsdc('0.0'), /zero|positive|invalid/i));

  it('rejects whitespace-only "  "', () =>
    assert.throws(() => toAtomicUsdc('  '), /invalid/i));
});

// ── expiryToLedger ───────────────────────────────────────────────────────────

describe('expiryToLedger', () => {
  it('30 days from ledger L = L + 30*17280', () => {
    const L = 1_000_000;
    assert.equal(expiryToLedger(30, L), L + 30 * 17_280);
  });

  it('1 day from ledger 100 = 17380', () =>
    assert.equal(expiryToLedger(1, 100), 100 + 17_280));

  it('7 days from ledger 0 = 120960', () =>
    assert.equal(expiryToLedger(7, 0), 7 * 17_280));

  it('fractional day rounds up (0.5 days)', () =>
    assert.equal(expiryToLedger(0.5, 0), Math.ceil(0.5 * 17_280)));

  // rejection cases
  it('rejects 0 days', () =>
    assert.throws(() => expiryToLedger(0, 100), /days|positive|invalid/i));

  it('rejects negative days', () =>
    assert.throws(() => expiryToLedger(-1, 100), /days|negative|invalid/i));

  it('rejects NaN days', () =>
    assert.throws(() => expiryToLedger(NaN, 100), /days|invalid/i));
});

// ── validateDelegation ───────────────────────────────────────────────────────

describe('validateDelegation', () => {
  it('accepts valid budget and days', () => {
    const result = validateDelegation({ budgetUsdc: '1', days: 7 });
    assert.equal(result.ok, true);
  });

  it('accepts higher budget', () => {
    const result = validateDelegation({ budgetUsdc: '100.5', days: 30 });
    assert.equal(result.ok, true);
  });

  it('rejects budget "0"', () => {
    const result = validateDelegation({ budgetUsdc: '0', days: 7 });
    assert.equal(result.ok, false);
    assert.ok('error' in result && typeof result.error === 'string');
  });

  it('rejects budget "-5"', () => {
    const result = validateDelegation({ budgetUsdc: '-5', days: 7 });
    assert.equal(result.ok, false);
    assert.ok('error' in result && typeof result.error === 'string');
  });

  it('rejects days 0', () => {
    const result = validateDelegation({ budgetUsdc: '1', days: 0 });
    assert.equal(result.ok, false);
    assert.ok('error' in result && typeof result.error === 'string');
  });

  it('rejects negative days', () => {
    const result = validateDelegation({ budgetUsdc: '1', days: -3 });
    assert.equal(result.ok, false);
    assert.ok('error' in result && typeof result.error === 'string');
  });

  it('rejects non-numeric budget', () => {
    const result = validateDelegation({ budgetUsdc: 'abc', days: 7 });
    assert.equal(result.ok, false);
  });

  it('rejects too many decimals', () => {
    const result = validateDelegation({ budgetUsdc: '1.12345678', days: 7 });
    assert.equal(result.ok, false);
  });
});
