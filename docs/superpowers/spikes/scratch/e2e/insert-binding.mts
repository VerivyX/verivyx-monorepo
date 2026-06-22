// Insert an McpWallet binding for the E2E test sub → the spike's OZ smart account
// + delegated session key. Uses the production registry's upsertBinding so the
// session secret is encrypted exactly as the pay path expects (MCP_WALLET_ENC_KEY).
//
// Run INSIDE the mcp-server container (has DATABASE_URL, MCP_WALLET_ENC_KEY, pg, tsx):
//   docker exec -e SUB=... -e SA=... -e SESSION_SEC=... -e BUDGET=... -e EXPIRY=... \
//     mcp-server tsx /work/insert-binding.mts
import { upsertBinding } from "/app/src/wallet/registry.ts";

const sub = process.env.SUB!;
const smartAccount = process.env.SA!;
const sessionSecret = process.env.SESSION_SEC!;
const sessionPub = process.env.SESSION_PUB!;
const budgetAtomic = BigInt(process.env.BUDGET!);
const expiryLedger = BigInt(process.env.EXPIRY!);

await upsertBinding({
  oauthSub: sub,
  smartAccount,
  sessionSignerPubkey: sessionPub,
  sessionSignerSecret: sessionSecret,
  budgetAtomic,
  expiryLedger,
});
console.log("BINDING UPSERTED for sub", sub, "-> SA", smartAccount, "expiry", expiryLedger.toString());
process.exit(0);
