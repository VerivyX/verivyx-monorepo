"use strict";
// Stage 13 — EXPIRY guard for the standard transfer model.
// Shorten the CallContract(USDC) rule's valid_until to a near-future ledger
// (OZ rejects setting it to the past with #3005), wait past it, then attempt a
// SESSION-authorized USDC.transfer → must FAIL (rule expired → no valid context).
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, optU32, scValToNative,
} = require("./lib");
const { signDelegated } = require("./authlib");

const USDC = process.env.USDC_CONTRACT_ID;

async function submitDelegated({ st, op, signerSecret, label }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100;
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc,{fee:"10000000",networkPassphrase:NET}).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) return { failed:true, where:"sim", err: sim.error };
  const auths = (sim.result?.auth||[]).map(a=> typeof a==="string"? xdr.SorobanAuthorizationEntry.fromXDR(a,"base64"): a);
  const signed = signDelegated({ auths, smartAccountId: sa, signerSecret, networkPassphrase: NET, expirationLedger: expiration });
  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc,{fee:"14000000",networkPassphrase:NET}).addOperation(op).setTimeout(120).build();
  { const env=tx2.toEnvelope(); env.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signed); tx2=new S.Transaction(env,NET); }
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) return { failed:true, where:"resim", err: sim2.error };
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  { const env2=prepared.toEnvelope(); const b2=env2.v1().tx().operations()[0].body().invokeHostFunctionOp(); if(b2.auth().length===0){b2.auth(signed);prepared=new S.Transaction(env2,NET);} }
  prepared.sign(deployer);
  const send = await server.sendTransaction(prepared);
  if (send.status==="ERROR") return { failed:true, where:"send", err: send.errorResult?.toXDR?.("base64") };
  let got = await server.getTransaction(send.hash);
  const dl=Date.now()+90000;
  while((got.status==="NOT_FOUND"||got.status==="PENDING")&&Date.now()<dl){await new Promise(r=>setTimeout(r,2000));got=await server.getTransaction(send.hash);}
  if (got.status!=="SUCCESS") return { failed:true, where:"tx", err:got.status, hash:send.hash };
  return { failed:false, hash:send.hash };
}

(async () => {
  const st = loadState();
  const sa = st.smartAccountId;
  // find the CallContract(USDC) rule id
  const opGet = Operation.invokeContractFunction({
    contract: sa, function: "get_context_rules",
    args: [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), new Address(USDC).toScVal()])],
  });
  const kp = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  let acc = await loadAccount(kp.publicKey());
  let tx = new S.TransactionBuilder(acc,{fee:"1000000",networkPassphrase:NET}).addOperation(opGet).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("get_context_rules: "+sim.error);
  const rules = scValToNative(sim.result.retval);
  const ruleId = rules[0].id;
  console.log("CallContract(USDC) rule id =", ruleId);

  // shorten valid_until to near-future, wait past it
  const latest = await server.getLatestLedger();
  const soonLedger = latest.sequence + 3;
  const opUpd = Operation.invokeContractFunction({
    contract: sa, function: "update_context_rule_valid_until",
    args: [ nativeToScVal(ruleId,{type:"u32"}), optU32(soonLedger) ],
  });
  const rUpd = await submitDelegated({ st, op: opUpd, signerSecret: st.keys.OWNERMASTER.sec, label: "shorten-transfer-rule" });
  if (rUpd.failed) throw new Error("could not shorten rule: "+JSON.stringify(rUpd).slice(0,300));
  console.log("rule valid_until shortened to %s tx=%s", soonLedger, rUpd.hash);

  let cur = (await server.getLatestLedger()).sequence;
  const wdl = Date.now() + 120000;
  while (cur <= soonLedger && Date.now() < wdl) { await new Promise(r=>setTimeout(r,4000)); cur = (await server.getLatestLedger()).sequence; console.log("  ledger now", cur, "waiting to pass", soonLedger); }
  if (cur <= soonLedger) throw new Error("ledger did not advance past expiry in time");
  console.log("ledger %s > valid_until %s — rule expired", cur, soonLedger);

  // attempt SESSION transfer -> must FAIL
  const opTransfer = Operation.invokeContractFunction({
    contract: USDC, function: "transfer",
    args: [ new Address(sa).toScVal(), new Address(st.keys.RECIPIENT.pub).toScVal(), nativeToScVal("500000",{type:"i128"}) ],
  });
  const g = await submitDelegated({ st, op: opTransfer, signerSecret: st.keys.SESSION.sec, label: "expired-session-transfer" });
  console.log("EXPIRY GUARD result:", JSON.stringify(g).slice(0,300));
  if (!g.failed) throw new Error("EXPIRY GUARD BROKEN: session transferred through an EXPIRED rule! tx="+g.hash);
  console.log("EXPIRY GUARD PASS: session transfer rejected after rule expiry (expected).");
  st.transferExpiryGuard = { shortenTx: rUpd.hash, rejected: true, where: g.where, err: g.err };
  saveState(st);
  console.log("STAGE13 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
