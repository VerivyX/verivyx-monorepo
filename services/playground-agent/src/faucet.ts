import { Horizon, Keypair, TransactionBuilder, Operation, Asset, Networks, BASE_FEE } from "@stellar/stellar-sdk";
import { config } from "./config.js";

const server = new Horizon.Server(config.horizonUrl);
const usdc = new Asset("USDC", config.usdcIssuer);
const faucetKp = Keypair.fromSecret(config.faucetSecret);

// Per-UTC-day cap on how many wallets the faucet will fund — abuse guard.
let dayKey = "";
let fundedToday = 0;

function rolloverDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    fundedToday = 0;
  }
}

export function faucetAddress(): string {
  return faucetKp.publicKey();
}

export async function faucetUsdcBalance(): Promise<string> {
  const acct = await server.loadAccount(faucetKp.publicKey());
  return acct.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === config.usdcIssuer)?.balance ?? "0";
}

// Send a small amount of test USDC to a freshly-created session wallet.
export async function sendTestUsdc(destination: string): Promise<void> {
  rolloverDay();
  if (fundedToday >= config.faucetDailyCap) {
    throw new Error("faucet daily cap reached — try again tomorrow");
  }
  const bal = Number(await faucetUsdcBalance());
  if (bal < Number(config.faucetUsdcPerWallet)) {
    throw new Error("faucet out of test USDC");
  }
  const acct = await server.loadAccount(faucetKp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination, asset: usdc, amount: config.faucetUsdcPerWallet }))
    .setTimeout(60)
    .build();
  tx.sign(faucetKp);
  await server.submitTransaction(tx);
  fundedToday += 1;
}
