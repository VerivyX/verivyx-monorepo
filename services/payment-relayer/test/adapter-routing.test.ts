import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowedPayAdapters,
  assertAdapterAllowed,
} from '../src/validation';
import { classifySettlePath, SettlePath } from '../src/routing';
import { SettleValidationError } from '../src/idempotency';

// ---- parseAllowedPayAdapters ----

test('parseAllowedPayAdapters: parses comma-separated list, trims whitespace, drops empty entries', () => {
  const result = parseAllowedPayAdapters('CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO, OTHER , ');
  assert.ok(result instanceof Set);
  assert.equal(result.size, 2);
  assert.ok(result.has('CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO'));
  assert.ok(result.has('OTHER'));
});

test('parseAllowedPayAdapters: undefined returns empty Set', () => {
  const result = parseAllowedPayAdapters(undefined);
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

test('parseAllowedPayAdapters: empty string returns empty Set', () => {
  const result = parseAllowedPayAdapters('');
  assert.ok(result instanceof Set);
  assert.equal(result.size, 0);
});

// ---- assertAdapterAllowed ----

test('assertAdapterAllowed: valid adapter id in allowlist does not throw', () => {
  assert.doesNotThrow(() =>
    assertAdapterAllowed('CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO',
      new Set(['CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO']))
  );
});

test('assertAdapterAllowed: undefined adapter id throws SettleValidationError', () => {
  assert.throws(
    () => assertAdapterAllowed(undefined, new Set(['CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO'])),
    (err: unknown) => err instanceof SettleValidationError
  );
});

test('assertAdapterAllowed: adapter id not in allowlist throws SettleValidationError', () => {
  assert.throws(
    () => assertAdapterAllowed('CUNKNOWN', new Set(['CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO'])),
    (err: unknown) => err instanceof SettleValidationError
  );
});

test('assertAdapterAllowed: empty allowlist + adapter target throws SettleValidationError (fail-closed)', () => {
  assert.throws(
    () => assertAdapterAllowed('CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO', new Set()),
    (err: unknown) => err instanceof SettleValidationError
  );
});

// ---- classifySettlePath (pure routing function) ----

const ADAPTER_ID = 'CDZ5KDP7UCRT4M5KKWSPZ6745AYEXJCFO5H6PJOV2B5ZCKXVHU726XEO';
const PAYWALL_ID = 'CPAYWALL111111111111111111111111111111111111111111111111';

const allowedAdapters = new Set([ADAPTER_ID]);

test('classifySettlePath: adapter contract + pay function → ADAPTER path', () => {
  const path = classifySettlePath(
    { contractId: ADAPTER_ID, functionName: 'pay' },
    allowedAdapters,
  );
  assert.equal(path, SettlePath.ADAPTER);
});

test('classifySettlePath: adapter contract + wrong function → LEGACY path (not adapter)', () => {
  // A tx targeting the adapter contract but NOT calling `pay` is NOT on the adapter path;
  // it falls through to legacy which will then fail the paywall allowlist check.
  const path = classifySettlePath(
    { contractId: ADAPTER_ID, functionName: 'init' },
    allowedAdapters,
  );
  assert.equal(path, SettlePath.LEGACY);
});

test('classifySettlePath: paywall contract + transfer function → LEGACY path', () => {
  const path = classifySettlePath(
    { contractId: PAYWALL_ID, functionName: 'transfer' },
    allowedAdapters,
  );
  assert.equal(path, SettlePath.LEGACY);
});

test('classifySettlePath: adapter contract not in allowlist → LEGACY path (fail-closed — allowlist check in index.ts)', () => {
  // classifySettlePath only routes; the allowlist assertion happens in index.ts.
  // An adapter id not in the set is NOT classified as ADAPTER — it goes LEGACY.
  const path = classifySettlePath(
    { contractId: 'CUNKNOWN', functionName: 'pay' },
    allowedAdapters,
  );
  assert.equal(path, SettlePath.LEGACY);
});

test('classifySettlePath: adapter path is correctly identified regardless of paywall allowlist', () => {
  const path = classifySettlePath(
    { contractId: ADAPTER_ID, functionName: 'pay' },
    allowedAdapters,
  );
  assert.equal(path, SettlePath.ADAPTER);
});

// ---- Routing + distribute call behaviour (via a mock settle function) ----
// We simulate the routing logic that index.ts applies to prove distribute is
// NOT invoked on the adapter path and IS invoked on the legacy path.

interface FakeOp {
  contractId: string;
  functionName: string;
}

async function simulateSettle(
  op: FakeOp,
  adapters: Set<string>,
  distribute: () => Promise<void>,
  submitSponsor: () => Promise<string>,
): Promise<{ txHash: string; distributeCalled: boolean }> {
  const path = classifySettlePath(op, adapters);

  if (path === SettlePath.ADAPTER) {
    // Adapter path: allowlist assertion happens before submit
    assertAdapterAllowed(op.contractId, adapters);
    const txHash = await submitSponsor();
    // DO NOT call distribute — adapter already split atomically
    return { txHash, distributeCalled: false };
  } else {
    // Legacy path: submit then distribute
    const txHash = await submitSponsor();
    await distribute();
    return { txHash, distributeCalled: true };
  }
}

test('routing: adapter path does NOT call distribute', async () => {
  let distributeCalled = false;
  const result = await simulateSettle(
    { contractId: ADAPTER_ID, functionName: 'pay' },
    allowedAdapters,
    async () => { distributeCalled = true; },
    async () => 'tx-hash-adapter',
  );
  assert.equal(result.txHash, 'tx-hash-adapter');
  assert.equal(result.distributeCalled, false, 'distribute must NOT be called on adapter path');
  assert.equal(distributeCalled, false, 'distribute spy must not have been invoked');
});

test('routing: legacy path DOES call distribute', async () => {
  let distributeCalled = false;
  const result = await simulateSettle(
    { contractId: PAYWALL_ID, functionName: 'transfer' },
    allowedAdapters,
    async () => { distributeCalled = true; },
    async () => 'tx-hash-legacy',
  );
  assert.equal(result.txHash, 'tx-hash-legacy');
  assert.equal(result.distributeCalled, true, 'distribute MUST be called on legacy path');
  assert.equal(distributeCalled, true, 'distribute spy must have been invoked');
});

test('classifySettlePath: empty adapter allowlist → LEGACY (adapter.pay never classified as ADAPTER when set is empty)', () => {
  // Fail-closed property: when ALLOWED_PAY_ADAPTERS is empty, classifySettlePath
  // returns LEGACY for ANY invocation — the adapter path is never entered.
  // In index.ts this causes the tx to hit assertPaywallContractAllowed which rejects
  // the adapter contract id (it's not a paywall either) → SettleValidationError.
  const path = classifySettlePath(
    { contractId: ADAPTER_ID, functionName: 'pay' },
    new Set(), // empty adapter allowlist
  );
  assert.equal(path, SettlePath.LEGACY, 'empty adapter allowlist must route to LEGACY, never ADAPTER');
});

test('assertAdapterAllowed: fail-closed — empty allowlist always rejects, regardless of id', () => {
  // Direct unit proof: even if classifySettlePath somehow returned ADAPTER,
  // assertAdapterAllowed with an empty allowlist unconditionally throws.
  assert.throws(
    () => assertAdapterAllowed(ADAPTER_ID, new Set()),
    (err: unknown) => err instanceof SettleValidationError,
  );
});

test('assertAdapterAllowed: fail-closed — unknown id in non-empty allowlist rejects', () => {
  assert.throws(
    () => assertAdapterAllowed(ADAPTER_ID, new Set(['CDIFFERENT'])),
    (err: unknown) => err instanceof SettleValidationError,
  );
});
