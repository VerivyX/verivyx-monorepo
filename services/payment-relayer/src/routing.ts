/**
 * Pure routing for the Soroban settle path.
 *
 * The relayer handles two distinct fee-sponsored Soroban paths:
 *
 * ADAPTER — verivyx_pay_adapter.pay(owner, domain, slug)
 *   The adapter performs the 3-way split atomically inside itself.
 *   Relayer must ONLY fee-sponsor; it must NOT call distribute.
 *
 * LEGACY — paywall_core.transfer(from, to, amount)
 *   The classic x402 path: agent transfers USDC to paywall_core,
 *   relayer sponsors + then calls keeper.distribute() to split.
 *
 * classifySettlePath is a pure function — no I/O, easily unit-tested.
 */

export const enum SettlePath {
  ADAPTER = 'ADAPTER',
  LEGACY  = 'LEGACY',
}

export interface InvokedOp {
  contractId: string;
  functionName: string;
}

/**
 * Classify the settle path for a fee-sponsored Soroban invocation.
 *
 * Returns SettlePath.ADAPTER if and only if:
 *   - contractId is in the allowedAdapters set (non-empty), AND
 *   - functionName === 'pay'
 *
 * Otherwise returns SettlePath.LEGACY (including unknown contract ids or
 * wrong function names on the adapter contract — fail-closed routing).
 *
 * Note: the assertAdapterAllowed / assertPaywallContractAllowed calls happen
 * in index.ts AFTER routing, not here. classifySettlePath only routes.
 */
export function classifySettlePath(
  op: InvokedOp,
  allowedAdapters: Set<string>,
  _allowedPaywalls: Set<string>,
): SettlePath {
  if (
    allowedAdapters.size > 0 &&
    allowedAdapters.has(op.contractId) &&
    op.functionName === 'pay'
  ) {
    return SettlePath.ADAPTER;
  }
  return SettlePath.LEGACY;
}
