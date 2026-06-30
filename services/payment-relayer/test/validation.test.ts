import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedPaywallContracts, assertPaywallContractAllowed, toStableError, atomicToStellar, resolveNetworkName } from '../src/validation';
import { SettleValidationError } from '../src/idempotency';

// parseAllowedPaywallContracts

test('parseAllowedPaywallContracts: parses comma-separated list, trims whitespace, drops empty entries', () => {
  const result = parseAllowedPaywallContracts('A, B ,, C');
  assert.ok(result instanceof Set);
  assert.equal(result.size, 3);
  assert.ok(result.has('A'));
  assert.ok(result.has('B'));
  assert.ok(result.has('C'));
});

test('parseAllowedPaywallContracts: undefined returns empty Set', () => {
  const result = parseAllowedPaywallContracts(undefined);
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test('parseAllowedPaywallContracts: empty string returns empty Set', () => {
  const result = parseAllowedPaywallContracts('');
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

// assertPaywallContractAllowed

test('assertPaywallContractAllowed: valid pc in allowlist does not throw', () => {
  assert.doesNotThrow(() => assertPaywallContractAllowed('A', new Set(['A'])));
});

test('assertPaywallContractAllowed: undefined pc throws SettleValidationError', () => {
  assert.throws(
    () => assertPaywallContractAllowed(undefined, new Set(['A'])),
    (err: unknown) => err instanceof SettleValidationError
  );
});

test('assertPaywallContractAllowed: pc not in allowlist throws SettleValidationError', () => {
  assert.throws(
    () => assertPaywallContractAllowed('B', new Set(['A'])),
    (err: unknown) => err instanceof SettleValidationError
  );
});

test('assertPaywallContractAllowed: empty allowlist throws SettleValidationError (fail-closed)', () => {
  assert.throws(
    () => assertPaywallContractAllowed('A', new Set()),
    (err: unknown) => err instanceof SettleValidationError
  );
});

// toStableError

test('toStableError: timeout error maps to 503 + settlement_timeout', () => {
  const result = toStableError(new Error('soroban_sponsor_submit_timeout'));
  assert.deepEqual(result, { status: 503, reason: 'settlement_timeout' });
});

test('toStableError: generic error maps to 500 + settlement_failed, no raw message in reason', () => {
  const rawMessage = 'Soroban send error: {"resultXdr":"AAAA...","extra":"sensitive"}';
  const result = toStableError(new Error(rawMessage));
  assert.deepEqual(result, { status: 500, reason: 'settlement_failed' });
  assert.ok(!result.reason.includes(rawMessage), 'reason must not contain raw error message');
});

test('toStableError: non-Error unknown maps to 500 + settlement_failed', () => {
  const result = toStableError('some string error');
  assert.deepEqual(result, { status: 500, reason: 'settlement_failed' });
});

// atomicToStellar — pure integer/string money math (no float)

test('atomicToStellar: "0" → "0.0000000"', () => {
  assert.equal(atomicToStellar('0'), '0.0000000');
});

test('atomicToStellar: "50000" → "0.0050000"', () => {
  assert.equal(atomicToStellar('50000'), '0.0050000');
});

test('atomicToStellar: "10000000" → "1.0000000"', () => {
  assert.equal(atomicToStellar('10000000'), '1.0000000');
});

test('atomicToStellar: "1" → "0.0000001"', () => {
  assert.equal(atomicToStellar('1'), '0.0000001');
});

test('atomicToStellar: "12345678" → "1.2345678"', () => {
  assert.equal(atomicToStellar('12345678'), '1.2345678');
});

test('atomicToStellar: large value beyond 2^53 is exact (proves no float path)', () => {
  // Float path: Number('90071992547409910') rounds to 90071992547409920 → off by 10 stroops.
  // (Number('90071992547409910') / 1e7).toFixed(7) === '9007199254.7409920' (wrong last digit)
  // Integer-string path must give '9007199254.7409910'
  const result = atomicToStellar('90071992547409910');
  assert.equal(result, '9007199254.7409910');
  assert.notEqual(result, (Number('90071992547409910') / 1e7).toFixed(7), 'must differ from (broken) float path for large values');
});

test('atomicToStellar: output always has exactly 7 decimal places (shape identical to old .toFixed(7))', () => {
  for (const val of ['0', '1', '50000', '10000000', '12345678', '100000000']) {
    const result = atomicToStellar(val);
    const parts = result.split('.');
    assert.equal(parts.length, 2, `expected decimal point in result for input ${val}`);
    assert.equal(parts[1].length, 7, `expected exactly 7 fractional digits for input ${val}, got "${result}"`);
  }
});

// resolveNetworkName — fail-fast STELLAR_NETWORK validation

test('resolveNetworkName: "testnet" resolves to "testnet"', () => {
  assert.equal(resolveNetworkName('testnet'), 'testnet');
});

test('resolveNetworkName: "public" resolves to "public"', () => {
  assert.equal(resolveNetworkName('public'), 'public');
});

test('resolveNetworkName: "mainnet" resolves to "public"', () => {
  assert.equal(resolveNetworkName('mainnet'), 'public');
});

test('resolveNetworkName: undefined (unset env var) defaults to "testnet"', () => {
  assert.equal(resolveNetworkName(undefined), 'testnet');
});

test('resolveNetworkName: typo "tesnet" throws with clear message', () => {
  assert.throws(
    () => resolveNetworkName('tesnet'),
    (err: unknown) => err instanceof Error && /Invalid STELLAR_NETWORK/.test(err.message)
  );
});

test('resolveNetworkName: "main" throws with clear message', () => {
  assert.throws(
    () => resolveNetworkName('main'),
    (err: unknown) => err instanceof Error && /Invalid STELLAR_NETWORK/.test(err.message)
  );
});

test('resolveNetworkName: empty string throws (not silently defaulted)', () => {
  assert.throws(
    () => resolveNetworkName(''),
    (err: unknown) => err instanceof Error && /Invalid STELLAR_NETWORK/.test(err.message)
  );
});
