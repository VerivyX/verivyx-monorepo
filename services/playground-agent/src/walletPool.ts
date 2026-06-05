import { Horizon, Keypair, TransactionBuilder, Operation, Asset, Networks, BASE_FEE } from "@stellar/stellar-sdk";
import pino from "pino";
import { config } from "./config.js";
import { sendTestUsdc } from "./faucet.js";

const log = pino({ name: "walletPool" });
const server = new Horizon.Server(config.horizonUrl);
const usdc = new Asset("USDC", config.usdcIssuer);

export type SessionWallet = { publicKey: string; secret: string };

const pool: SessionWallet[] = [];
let replenishing = false;

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // testnet Horizon/friendbot are flaky
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${last instanceof Error ? last.message : last}`);
}

// Create a fresh testnet wallet: friendbot XLM → USDC trustline → faucet top-up.
async function provision(): Promise<SessionWallet> {
  const kp = Keypair.random();

  await retry("friendbot", async () => {
    const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  });

  await retry("trustline", async () => {
    const acct = await server.loadAccount(kp.publicKey());
    const trustTx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    trustTx.sign(kp);
    await server.submitTransaction(trustTx);
  });

  // Faucet payment is serialized via the single-flight replenish loop below,
  // so the faucet account never collides on its sequence number.
  await retry("faucet", () => sendTestUsdc(kp.publicKey()));

  log.info({ wallet: kp.publicKey() }, "provisioned session wallet");
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

// Single-flight, SEQUENTIAL top-up to poolSize. Sequential is required: every
// provision ends with a payment from the one faucet account.
async function replenish(): Promise<void> {
  if (replenishing) return;
  replenishing = true;
  try {
    while (pool.length < config.poolSize) {
      try {
        pool.push(await provision());
      } catch (e) {
        log.warn({ err: e instanceof Error ? e.message : e }, "provision failed; will retry next cycle");
        break;
      }
    }
  } finally {
    replenishing = false;
  }
}

export function startWalletPool(): void {
  replenish().catch((e) => log.warn({ err: e?.message }, "initial replenish failed"));
  // Periodically top up + recover from transient failures.
  setInterval(() => replenish().catch(() => {}), 30_000);
}

// Hand a funded wallet to a new session. Falls back to provisioning on demand
// if the pool is momentarily empty, then triggers a background refill.
export async function acquireWallet(): Promise<SessionWallet> {
  const w = pool.shift();
  replenish().catch(() => {});
  if (w) return w;
  return provision();
}

export async function walletBalances(publicKey: string): Promise<{ usdc: string; xlm: string }> {
  const acct = await server.loadAccount(publicKey);
  let u = "0";
  let x = "0";
  for (const b of acct.balances) {
    if (b.asset_type === "native") x = b.balance;
    else if ("asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === config.usdcIssuer) u = b.balance;
  }
  return { usdc: u, xlm: x };
}
