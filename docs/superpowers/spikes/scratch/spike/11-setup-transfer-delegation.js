"use strict";
// Stage 11 — set up the delegation for the STANDARD x402 transfer model.
//   add_context_rule(CallContract(USDC), valid_until, [Delegated(SESSION)], {})
// Authorized by OWNERMASTER (the Delegated signer on the account's Default rule).
//
// KEY DIFFERENCE vs the adapter spike: the called contract is the USDC SAC, not
// the adapter. CallContract(USDC) lets the session authorize USDC.transfer to ANY
// `to` (payTo varies per resource); the amount cap is the (optional) spending_limit
// policy + the SA's USDC balance.
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative,
  signerDelegated, ctxCallContract, optU32, vecSigners,
} = require("./lib");
const { signDelegated } = require("./authlib");

const USDC = process.env.USDC_CONTRACT_ID;

async function submitWithDelegatedAuth({ op, signerSecret, smartAccountId, label }) {
  const deployer = Keypair.fromSecret(loadState().keys.DEPLOYER.sec);
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 600;
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc, { fee: "8000000", networkPassphrase: NET }).addOperation(op).setTimeout(180).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`[${label}] sim: ${sim.error}`);
  const auths = (sim.result?.auth || []).map(a => typeof a === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(a, "base64") : a);
  console.log(`[${label}] auth entries from sim: ${auths.length}`);
  const signed = signDelegated({ auths, smartAccountId, signerSecret, networkPassphrase: NET, expirationLedger: expiration });
  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc, { fee: "10000000", networkPassphrase: NET }).addOperation(op).setTimeout(180).build();
  { const env = tx2.toEnvelope(); env.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signed); tx2 = new S.Transaction(env, NET); }
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) throw new Error(`[${label}] resim: ${sim2.error}`);
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  { const env2 = prepared.toEnvelope(); const b2 = env2.v1().tx().operations()[0].body().invokeHostFunctionOp(); if (b2.auth().length === 0) { b2.auth(signed); prepared = new S.Transaction(env2, NET); } }
  prepared.sign(deployer);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`[${label}] send ERROR: ${JSON.stringify(send.errorResult?.toXDR?.("base64") || send)}`);
  let got = await server.getTransaction(send.hash);
  const dl = Date.now() + 90000;
  while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) { await new Promise(r=>setTimeout(r,2000)); got = await server.getTransaction(send.hash); }
  if (got.status !== "SUCCESS") throw new Error(`[${label}] TX ${got.status}: ${send.hash}\n${JSON.stringify(got.resultXdr?.toXDR?.("base64") || "")}`);
  return { hash: send.hash, expiration, returnValue: got.returnValue };
}

(async () => {
  const st = loadState();
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const validUntil = latest.sequence + 500; // context-rule expiry (ledgers, ~40min)

  // add_context_rule(CallContract(USDC), valid_until, [Delegated(SESSION)], {})
  const opRule = Operation.invokeContractFunction({
    contract: sa, function: "add_context_rule",
    args: [
      ctxCallContract(USDC),
      nativeToScVal("verivyx-x402-transfer", { type: "string" }),
      optU32(validUntil),
      vecSigners([signerDelegated(st.keys.SESSION.pub)]),
      xdr.ScVal.scvMap([]),
    ],
  });
  const r = await submitWithDelegatedAuth({ op: opRule, signerSecret: st.keys.OWNERMASTER.sec, smartAccountId: sa, label: "add_transfer_rule" });
  st.transferRuleTx = r.hash; st.transferValidUntil = validUntil;
  let ruleId;
  try { const rv = scValToNative(r.returnValue); ruleId = rv?.id; st.transferRule = rv; } catch {}
  st.transferRuleId = ruleId;
  saveState(st);
  console.log("add_context_rule(CallContract(USDC)) done tx=%s ruleId=%s validUntil=%s", r.hash, ruleId, validUntil);
  console.log("STAGE11 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
