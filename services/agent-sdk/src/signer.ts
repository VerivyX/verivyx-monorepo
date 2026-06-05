// Stellar signer: receives a pre-built transaction XDR, signs it, and returns
// the signed XDR. The agent.ts is responsible for constructing the transaction.
//
// Two flavours are exposed:
//
//   - SignerFn: arbitrary callable the agent can plug in (BYO wallet, MPC, KMS).
//     Receives a base64 XDR string, returns a signed base64 XDR string.
//   - createStellarSigner(): a built-in implementation that signs with a raw
//     secret key. Pulls @stellar/stellar-sdk lazily so this package can also be
//     used as types-only by callers who BYO signer.
//
// Wire format: the gateway expects payload = { transaction: "<base64-xdr>" }.

/**
 * Pluggable signing function. Receives a base64-encoded transaction XDR,
 * signs it with the agent's key material, and returns the signed XDR.
 */
export type SignerFn = (txXdr: string) => Promise<string>;

export interface StellarSignerOptions {
  secretKey: string;
  networkPassphrase?: string;
  /** Horizon RPC URL. Defaults to testnet or mainnet based on networkPassphrase. */
  horizonURL?: string;
}

/**
 * Built-in signer for Stellar classic Payment operations.
 *
 * Receives the skeleton XDR built by PaywallAgent (which uses a placeholder
 * source account). This signer:
 *   1. Derives the real payer public key from secretKey.
 *   2. Fetches the real account sequence from Horizon.
 *   3. Rebuilds the TX with the correct source + sequence, preserving all ops.
 *   4. Signs and returns the final XDR.
 *
 * This ensures the transaction is valid on-chain (correct source, correct sequence).
 */
export function createStellarSigner(opts: StellarSignerOptions): SignerFn {
  const { secretKey } = opts;
  if (typeof secretKey !== 'string' || !secretKey.startsWith('S') || secretKey.length !== 56) {
    throw new Error('createStellarSigner: secretKey must be a Stellar secret seed (S…)');
  }
  return async (txXdr: string): Promise<string> => {
    const sdk = await import('@stellar/stellar-sdk');
    const { Keypair, Networks, TransactionBuilder, Horizon } = sdk as typeof import('@stellar/stellar-sdk');

    const networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
    const isMainnet = networkPassphrase === Networks.PUBLIC;
    const horizonURL = opts.horizonURL ?? (isMainnet
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');

    const keypair = Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();

    // Fetch real account so we have the correct sequence number.
    const server = new Horizon.Server(horizonURL);
    const account = await server.loadAccount(publicKey);

    // Extract operations from the skeleton TX (built with placeholder source).
    const skelTx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);

    // Rebuild TX with real source account + sequence, same operations.
    const txBuilder = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase,
    });
    for (const op of skelTx.operations) {
      // stellar-sdk v13: fromXDR output type diverges from addOperation input type
      // at compile time but is runtime-compatible — bridge via unknown.
      txBuilder.addOperation(op as unknown as Parameters<typeof txBuilder.addOperation>[0]);
    }
    const tx = txBuilder.setTimeout(60).build();
    tx.sign(keypair);
    return tx.toEnvelope().toXDR('base64');
  };
}
