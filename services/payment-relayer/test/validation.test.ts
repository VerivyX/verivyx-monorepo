import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedPaywallContracts, assertPaywallContractAllowed, toStableError } from '../src/validation';
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
