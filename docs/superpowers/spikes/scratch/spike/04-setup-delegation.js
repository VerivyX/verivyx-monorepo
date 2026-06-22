"use strict";
// Stage 4: ONE owner-signed flow:
//   (a) USDC.approve(from=smartAccount, spender=adapter, budget, expiration_ledger)
//   (b) smartAccount.add_context_rule(CallContract(adapter), valid_until, [Delegated(SESSION)], {})
// Both require the smart account's auth -> satisfied by OWNERMASTER (Delegated signer on Default rule).
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative,
  signerDelegated, ctxCallContract, optU32, vecSigners,
} = require("./lib");
const { signDelegated } = require("./authlib");

const ADAPTER = process.env.VERIVYX_PAY_ADAPTER_ID;
const USDC = process.env.USDC_CONTRACT_ID;

async function submitWithDelegatedAuth({ ops, signerSecret, smartAccountId, label }) {
  const deployer = Keypair.fromSecret(loadState().keys.DEPLOYER.sec);
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 600; // ~50 min, must cover valid_until usage window
  // 1) simulate to discover auth entries
  let acc = await loadAccount(deployer.publicKey());
  let b = new S.TransactionBuilder(acc, { fee: "5000000", networkPassphrase: NET });
  for (const op of ops) b.addOperation(op);
  let tx = b.setTimeout(180).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`[${label}] sim: ${sim.error}`);
  const auths = (sim.result?.auth || []).map(a => typeof a === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(a, "base64") : a);
  console.log(`[${label}] auth entries from sim: ${auths.length}`);

  // 2) sign smart-account entries via the Delegated signer
  const signed = signDelegated({ auths, smartAccountId, signerSecret, networkPassphrase: NET, expirationLedger: expiration });

  // 3) rebuild op(s) with signed auth. Re-build the host-function op carrying auth.
  //    Easiest: reconstruct each invokeHostFunction op from sim is complex; instead
  //    set auth on the existing operation(s). For multi-op txs, auth applies per-op,
  //    so we rebuild the tx attaching ALL signed entries to the single op that needs them.
  //    Our two ops each generate their own smart-account auth entry; we must map them.
  //    Simpler & robust: do ONE op per tx. (Caller passes a single op.)
  if (ops.length !== 1) throw new Error("submitWithDelegatedAuth expects exactly 1 op");
  acc = await loadAccount(deployer.publicKey());
  const op = ops[0];
  // Rebuild the operation with auth attached.
  const rawOp = op; // Operation.invokeContractFunction returns an xdr op with auth slot
  // Reconstruct via invokeHostFunction to attach auth:
  const opXdr = op.toXDR ? null : null;
  // Use the high-level: rebuild tx, then overwrite the operation's auth via xdr.
  let tx2 = new S.TransactionBuilder(acc, { fee: "8000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(180).build();
  // inject signed auth into the op
  const env = tx2.toEnvelope();
  const operations = env.v1().tx().operations();
  const body = operations[0].body();
  body.invokeHostFunctionOp().auth(signed);
  tx2 = new S.Transaction(env, NET);

  // 4) re-simulate with signed auth to get accurate resource fees
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) throw new Error(`[${label}] resim: ${sim2.error}`);
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  // assembleTransaction may strip our manual auth; re-inject if needed
  {
    const env2 = prepared.toEnvelope();
    const ops2 = env2.v1().tx().operations();
    const body2 = ops2[0].body();
    if (body2.invokeHostFunctionOp().auth().length === 0) {
      body2.invokeHostFunctionOp().auth(signed);
      prepared = new S.Transaction(env2, NET);
    }
  }
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
  const validUntil = latest.sequence + 500; // context-rule expiry (ledgers)
  const budget = 1_020_000; // 0.102 USDC: covers exactly 2x (price 500000 + platform within price) + headroom

  // (a) approve: USDC.approve(from, spender, amount, expiration_ledger)
  const approveExp = latest.sequence + 200000; // allowance ledger expiry
  const opApprove = Operation.invokeContractFunction({
    contract: USDC, function: "approve",
    args: [
      new Address(sa).toScVal(),
      new Address(ADAPTER).toScVal(),
      nativeToScVal(budget, { type: "i128" }),
      nativeToScVal(approveExp, { type: "u32" }),
    ],
  });
  const rApprove = await submitWithDelegatedAuth({ ops: [opApprove], signerSecret: st.keys.OWNERMASTER.sec, smartAccountId: sa, label: "approve" });
  st.approveTx = rApprove.hash; st.budget = budget; saveState(st);
  console.log("approve done", rApprove.hash);

  // (b) add_context_rule(CallContract(adapter), valid_until, [Delegated(SESSION)], {})
  const opRule = Operation.invokeContractFunction({
    contract: sa, function: "add_context_rule",
    args: [
      ctxCallContract(ADAPTER),
      nativeToScVal("verivyx-session", { type: "string" }),
      optU32(validUntil),
      vecSigners([signerDelegated(st.keys.SESSION.pub)]),
      xdr.ScVal.scvMap([]),
    ],
  });
  const rRule = await submitWithDelegatedAuth({ ops: [opRule], signerSecret: st.keys.OWNERMASTER.sec, smartAccountId: sa, label: "add_context_rule" });
  st.addRuleTx = rRule.hash; st.validUntil = validUntil;
  // capture rule id from return value
  try { st.ruleReturn = scValToNative(rRule.returnValue); } catch {}
  saveState(st);
  console.log("add_context_rule done", rRule.hash, "validUntil", validUntil);
  console.log("STAGE4 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
