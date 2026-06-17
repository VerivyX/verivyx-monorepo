import { scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';

// resolvePayer picks the most reliable payer address: the client-declared payer,
// else the Soroban transfer `from` arg, else the tx source. In the fee-sponsored
// Soroban path the tx source is a null placeholder, so it is only a last resort.
export function resolvePayer(declared: string | undefined, sorobanFrom: string, txSource: string): string {
  return declared || sorobanFrom || txSource;
}

// extractSorobanFrom returns the `from` argument (arg 0) of a single
// invokeHostFunction transfer(from, to, amount), or '' when the tx is not such a
// call. Mirrors the arg parsing in validateSorobanTransfer (args[1]=to, args[2]=amount).
export function extractSorobanFrom(tx: Transaction): string {
  try {
    const op = tx.operations[0];
    if (!op || op.type !== 'invokeHostFunction') return '';
    const hostFn = (op as unknown as { func: xdr.HostFunction }).func;
    if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') return '';
    const ic = hostFn.invokeContract();
    if (ic.functionName().toString() !== 'transfer') return '';
    const args = ic.args();
    if (args.length !== 3) return '';
    return String(scValToNative(args[0]));
  } catch {
    return '';
  }
}
