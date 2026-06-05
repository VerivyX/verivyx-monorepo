# @verivyx/agent-sdk

Client SDK for AI agents to fetch paywalled content from a Verivyx installation. Handles the full HTTP 402 → x402 settle → re-hydrate handshake on Stellar Soroban USDC.

## Install

```bash
npm install @verivyx/agent-sdk @stellar/stellar-sdk
```

The Stellar SDK is a peer dependency only if you use the bundled signer; bring-your-own signer flows can omit it.

## Usage

```ts
import { PaywallAgent, createStellarSigner } from '@verivyx/agent-sdk';

const agent = new PaywallAgent({
  apiBase: 'https://api.verivyx.com',
  network: 'stellar:testnet',
  signer: createStellarSigner({ secretKey: process.env.STELLAR_SECRET! }),
  maxAmountAtomic: 100_000n, // refuse > 0.01 USDC per request
});

const { status, content, transaction } = await agent.getContent(
  'creator.example',
  'my-article',
);

console.log(status);          // 'served' or 'paid_then_served'
console.log(transaction);     // tx hash if a payment happened
console.log(content.body);    // the unlocked content
```

## Bring-your-own signer

If you sign with KMS, MPC, or a hardware wallet, pass any callable that returns a signed Soroban envelope:

```ts
const agent = new PaywallAgent({
  apiBase,
  network: 'stellar:testnet',
  signer: async ({ payTo, asset, amount, network }) => {
    const tx = await myCustomSigningFlow(payTo, asset, amount, network);
    return { transaction: tx.xdrBase64, payer: tx.publicKey };
  },
});
```

The signer receives the matched `PaymentRequirement` (payTo, asset, amount, network, resourceUrl) and returns `{ transaction, payer }` — the gateway forwards `transaction` to the facilitator.

## Idempotency

Every `/settle` call sends an `Idempotency-Key`. If the network drops between settle and the response, you can safely retry: the gateway replays the cached settlement instead of re-charging the wallet.

## Errors

```ts
import {
  PaywallError,
  NoMatchingRequirementError,
  SettlementFailedError,
  HydrationFailedError,
} from '@verivyx/agent-sdk';

try {
  await agent.getContent(domain, slug);
} catch (err) {
  if (err instanceof SettlementFailedError) console.error('payment rejected:', err.response);
  else if (err instanceof NoMatchingRequirementError) console.error('no compatible scheme');
  else throw err;
}
```

## Network → RPC defaults

| Network            | Soroban RPC                                        |
| ------------------ | -------------------------------------------------- |
| `stellar:testnet`  | `https://soroban-testnet.stellar.org`              |
| `stellar:pubnet`   | `https://soroban-rpc.mainnet.stellar.org:443`      |

Override via `createStellarSigner({ rpcUrl })`.

## License

MIT
