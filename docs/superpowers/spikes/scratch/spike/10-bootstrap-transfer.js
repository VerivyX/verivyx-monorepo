"use strict";
// Stage 10 (standard-transfer spike) — bootstrap state for the STANDARD x402
// transfer model. Reuses the EXISTING OZ smart account + session key from the
// prior adapter.pay spike (SPIKE_OZ_* in .env). Ensures:
//   - the smart account exists (SPIKE_OZ_SMART_ACCOUNT_ID)
//   - DEPLOYER (fee payer / source) funded
//   - SESSION key funded on-chain (required for require_auth_for_args)
//   - a fresh RECIPIENT G-account (the x402 `payTo`) funded + trustlined to USDC
//   - the smart account holds USDC (faucet tops it up if low)
//
// Writes state.json consumed by 11-/12-/13-.
const {
  Keypair, Operation, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative, friendbot,
  buildSimSignSubmit,
} = require("./lib");

const USDC = process.env.USDC_CONTRACT_ID;
const USDC_ISSUER = process.env.USDC_ISSUER;
const FAUCET = process.env.PLAYGROUND_FAUCET_SECRET;

function envKp(name) {
  const sec = process.env[name];
  if (!sec) throw new Error(`missing env ${name}`);
  return Keypair.fromSecret(sec);
}

async function balance(addr) {
  const op = Operation.invokeContractFunction({ contract: USDC, function: "balance", args: [new Address(addr).toScVal()] });
  const kp = envKp("SPIKE_OZ_DEPLOYER_SEC");
  const acc = await loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("balance sim " + addr + ": " + sim.error);
  return BigInt(scValToNative(sim.result.retval).toString());
}

(async () => {
  const st = loadState();

  // Reuse existing OZ keys/account from env (the prior spike's, gitignored)
  const ownerMaster = envKp("SPIKE_OZ_OWNERMASTER_SEC");
  const session = envKp("SPIKE_OZ_SESSION_SEC");
  const deployer = envKp("SPIKE_OZ_DEPLOYER_SEC");
  const smartAccountId = process.env.SPIKE_OZ_SMART_ACCOUNT_ID;
  if (!smartAccountId) throw new Error("SPIKE_OZ_SMART_ACCOUNT_ID not set — deploy account first");

  st.smartAccountId = smartAccountId;
  st.keys = st.keys || {};
  st.keys.OWNERMASTER = { sec: ownerMaster.secret(), pub: ownerMaster.publicKey() };
  st.keys.SESSION = { sec: session.secret(), pub: session.publicKey() };
  st.keys.DEPLOYER = { sec: deployer.secret(), pub: deployer.publicKey() };

  // Fresh recipient (the x402 payTo) — a G-account we control, needs trustline.
  if (!st.keys.RECIPIENT) {
    const r = Keypair.random();
    st.keys.RECIPIENT = { sec: r.secret(), pub: r.publicKey() };
    console.log("generated RECIPIENT", r.publicKey());
  }
  saveState(st);

  // Fund XLM for all G-accounts that need to exist on-chain.
  for (const name of ["DEPLOYER", "SESSION", "RECIPIENT"]) {
    const pub = st.keys[name].pub;
    await friendbot(pub);
    console.log("friendbot ok", name, pub);
  }

  // RECIPIENT trustline to USDC (G-accounts need a trustline to hold SAC USDC).
  const recip = Keypair.fromSecret(st.keys.RECIPIENT.sec);
  const racc = await loadAccount(recip.publicKey());
  const hasTrust = racc.balances?.some?.(b => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  if (!hasTrust) {
    const ct = new S.TransactionBuilder(racc, { fee: "1000000", networkPassphrase: NET })
      .addOperation(Operation.changeTrust({ asset: new S.Asset("USDC", USDC_ISSUER) }))
      .setTimeout(120).build();
    ct.sign(recip);
    const r = await server.sendTransaction(ct);
    if (r.status === "ERROR") throw new Error("changeTrust ERROR " + JSON.stringify(r.errorResult?.toXDR?.("base64") || r));
    let got = await server.getTransaction(r.hash);
    const dl = Date.now() + 60000;
    while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) { await new Promise(x=>setTimeout(x,2000)); got = await server.getTransaction(r.hash); }
    if (got.status !== "SUCCESS") throw new Error("changeTrust TX " + got.status + " " + r.hash);
    console.log("RECIPIENT trustline established", r.hash);
  } else {
    console.log("RECIPIENT already trustlined");
  }

  // Top up the smart account with USDC from the faucet if low (SAC transfer to C-address, no trustline needed).
  const saBal = await balance(smartAccountId);
  console.log("smart account USDC balance:", saBal.toString());
  const TARGET = 5_000_000n; // 0.5 USDC of headroom
  if (saBal < TARGET) {
    const need = (TARGET - saBal).toString();
    const faucet = Keypair.fromSecret(FAUCET);
    const op = Operation.invokeContractFunction({
      contract: USDC, function: "transfer",
      args: [ new Address(faucet.publicKey()).toScVal(), new Address(smartAccountId).toScVal(), nativeToScVal(need, { type: "i128" }) ],
    });
    await buildSimSignSubmit({ sourceSecret: FAUCET, op, label: "faucet-fund-SA" });
    console.log("funded SA with", need, "stroops USDC");
  }
  const saBal2 = await balance(smartAccountId);
  console.log("smart account USDC balance now:", saBal2.toString());

  st.usdc = USDC;
  saveState(st);
  console.log("STAGE10 bootstrap done. SA=%s session=%s recipient=%s", smartAccountId, st.keys.SESSION.pub, st.keys.RECIPIENT.pub);
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
