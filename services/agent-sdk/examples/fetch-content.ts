// Example: an AI agent gains access to paywalled content, paying via x402 if needed.
//
// Under the new architecture, the hydration service is a gate-only service —
// it returns an access decision, NOT the content body. After getAccess() resolves,
// the agent fetches content directly from the creator's origin URL.
//
// Run:
//   STELLAR_SECRET_KEY=S... npx tsx examples/fetch-content.ts
//
// Prerequisites:
//   - The Stellar account funded with testnet USDC and trustline to the USDC asset.
//   - The hydration service reachable at http://localhost:8082.

import { PaywallAgent, PaywallError } from '../src/index.js';
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

// Signer function — wrap private key.
// JANGAN hardcode private key di production — gunakan env var atau KMS.
const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET_KEY!);

const signer = async (txXdr: string): Promise<string> => {
  const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
  tx.sign(keypair);
  return tx.toEnvelope().toXDR('base64');
};

const agent = new PaywallAgent({
  apiBase: 'http://localhost:8082', // hydration-service
  network: 'stellar:testnet',
  signer,
  maxAmountAtomic: 100_000n, // max 0.01 USDC per request
});

async function main() {
  try {
    const result = await agent.getAccess({
      domain: 'example.com',
      slug: 'premium-article',
    });

    console.log('Access status:', result.status);
    // 'already_open'  — sudah ada session dari payment sebelumnya
    // 'paid_then_open' — baru bayar, session aktif 1 jam

    if (result.transaction) {
      console.log('TX Hash:', result.transaction);
    }

    // Setelah getAccess() sukses, agent bisa akses konten creator
    // langsung dari URL mereka (konten ada di server creator, bukan Verivyx).
    // const content = await fetch('https://example.com/premium-article');

  } catch (err) {
    if (err instanceof PaywallError) {
      console.error(`PaywallError [${err.code}]:`, err.message);
    } else {
      throw err;
    }
  }
}

main();
