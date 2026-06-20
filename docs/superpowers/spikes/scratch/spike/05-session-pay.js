"use strict";
// Stage 5 — THE CRUX: adapter.pay(owner=smartAccount, domain, slug) authorized by
// the SESSION key ONLY (OWNERMASTER does NOT sign). Settles a real USDC payment.
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative,
} = require("./lib");
const { signDelegated } = require("./authlib");

const ADAPTER = process.env.VERIVYX_PAY_ADAPTER_ID;
const USDC = process.env.USDC_CONTRACT_ID;
const PLATFORM = process.env.PLATFORM_STELLAR_ADDRESS;

async function balance(addr) {
  const op = Operation.invokeContractFunction({ contract: USDC, function: "balance", args: [new Address(addr).toScVal()] });
  const kp = Keypair.fromSecret(loadState().keys.DEPLOYER.sec);
  const acc = await loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("balance sim " + addr + ": " + sim.error);
  return BigInt(scValToNative(sim.result.retval).toString());
}

async function sessionPay({ st, signerSecret, label, domain, slug }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100;

  const op = Operation.invokeContractFunction({
    contract: ADAPTER, function: "pay",
    args: [
      new Address(sa).toScVal(),
      nativeToScVal(domain, { type: "string" }),
      nativeToScVal(slug, { type: "string" }),
    ],
  });

  // simulate (no auth) to discover the smart-account auth entry the host wants
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc, { fee: "8000000", networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`[${label}] sim: ${sim.error}`);
  const auths = (sim.result?.auth || []).map(a => typeof a === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(a, "base64") : a);
  console.log(`[${label}] auth entries: ${auths.length}`);

  // sign smart-account entry with SESSION (the Delegated rule signer)
  const signed = signDelegated({ auths, smartAccountId: sa, signerSecret, networkPassphrase: NET, expirationLedger: expiration });

  // attach signed auth, re-simulate, submit
  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc, { fee: "12000000", networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  {
    const env = tx2.toEnvelope();
    env.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signed);
    tx2 = new S.Transaction(env, NET);
  }
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) throw new Error(`[${label}] resim: ${sim2.error}`);
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  {
    const env2 = prepared.toEnvelope();
    const b2 = env2.v1().tx().operations()[0].body().invokeHostFunctionOp();
    if (b2.auth().length === 0) { b2.auth(signed); prepared = new S.Transaction(env2, NET); }
  }
  prepared.sign(deployer);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`[${label}] send ERROR: ${send.errorResult?.toXDR?.("base64") || JSON.stringify(send)}`);
  let got = await server.getTransaction(send.hash);
  const dl = Date.now() + 90000;
  while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) { await new Promise(r=>setTimeout(r,2000)); got = await server.getTransaction(send.hash); }
  if (got.status !== "SUCCESS") throw new Error(`[${label}] TX ${got.status}: ${send.hash}\n${got.resultXdr?.toXDR?.("base64") || ""}`);
  return send.hash;
}

(async () => {
  const st = loadState();
  const { DOMAIN, SLUG, PRICE, PLATFORM_FEE } = st.config;
  const sa = st.smartAccountId;
  const creator = st.keys.CREATOR.pub;

  const beforeOwner = await balance(sa);
  const beforeCreator = await balance(creator);
  const beforePlatform = await balance(PLATFORM);
  console.log("BEFORE: owner(SA)=%s creator=%s platform=%s", beforeOwner, beforeCreator, beforePlatform);

  const hash = await sessionPay({ st, signerSecret: st.keys.SESSION.sec, label: "session-pay", domain: DOMAIN, slug: SLUG });
  console.log("SESSION PAY SETTLED tx =", hash);
  st.sessionPayTx = hash; saveState(st);

  const afterOwner = await balance(sa);
  const afterCreator = await balance(creator);
  const afterPlatform = await balance(PLATFORM);
  console.log("AFTER:  owner(SA)=%s creator=%s platform=%s", afterOwner, afterCreator, afterPlatform);

  const dOwner = afterOwner - beforeOwner;
  const dCreator = afterCreator - beforeCreator;
  const dPlatform = afterPlatform - beforePlatform;
  console.log("DELTA:  owner=%s creator=%s platform=%s", dOwner, dCreator, dPlatform);

  // expected: creator += price-platform_fee; platform += platform_fee; owner -= price (+fee_atomic if any)
  const expCreator = BigInt(PRICE - PLATFORM_FEE);
  const expPlatform = BigInt(PLATFORM_FEE);
  st.deltas = { owner: dOwner.toString(), creator: dCreator.toString(), platform: dPlatform.toString() };
  st.feeAtomicInferred = (-dOwner - BigInt(PRICE)).toString();
  saveState(st);
  console.log("EXPECT: creator +%s platform +%s ; owner -%s(price) - fee_atomic", expCreator, expPlatform, PRICE);
  console.log("INFERRED fee_atomic (extra owner debit beyond price) =", st.feeAtomicInferred);

  if (dCreator !== expCreator) throw new Error(`creator delta mismatch: got ${dCreator} want ${expCreator}`);
  if (dPlatform !== expPlatform) throw new Error(`platform delta mismatch: got ${dPlatform} want ${expPlatform}`);
  console.log("VERIFIED: creator + platform deltas match on-chain price.");
  console.log("STAGE5 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
