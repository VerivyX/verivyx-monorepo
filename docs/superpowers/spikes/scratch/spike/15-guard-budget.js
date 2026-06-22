"use strict";
// Stage 15 — BUDGET guard via the OZ spending_limit policy (added in stage 14).
// Budget = SPENDING_LIMIT (1_500_000) per PERIOD_LEDGERS (100).
//   A) session transfer of 800_000  -> SUCCEEDS (within budget)
//   B) session transfer of 900_000  -> REJECTED (800_000+900_000 = 1_700_000 > 1_500_000)
// Proves the spending_limit policy meters USDC.transfer and blocks period overspend.
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative,
} = require("./lib");
const { signDelegated } = require("./authlib");

const USDC = process.env.USDC_CONTRACT_ID;

async function balance(addr) {
  const op = Operation.invokeContractFunction({ contract: USDC, function: "balance", args: [new Address(addr).toScVal()] });
  const kp = Keypair.fromSecret(loadState().keys.DEPLOYER.sec);
  const acc = await loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("balance sim: " + sim.error);
  return BigInt(scValToNative(sim.result.retval).toString());
}

async function sessionTransfer({ st, to, amount, label }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100;
  const op = Operation.invokeContractFunction({
    contract: USDC, function: "transfer",
    args: [ new Address(sa).toScVal(), new Address(to).toScVal(), nativeToScVal(amount.toString(), { type: "i128" }) ],
  });
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc,{fee:"10000000",networkPassphrase:NET}).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) return { failed:true, where:"sim", err: sim.error };
  const auths = (sim.result?.auth||[]).map(a=> typeof a==="string"? xdr.SorobanAuthorizationEntry.fromXDR(a,"base64"): a);
  const signed = signDelegated({ auths, smartAccountId: sa, signerSecret: st.keys.SESSION.sec, networkPassphrase: NET, expirationLedger: expiration });
  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc,{fee:"12000000",networkPassphrase:NET}).addOperation(op).setTimeout(120).build();
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
  const recipient = st.keys.RECIPIENT.pub;

  // A) within budget: 800_000 (< 1_500_000)
  const a0r = await balance(recipient);
  const a = await sessionTransfer({ st, to: recipient, amount: 800_000n, label: "within-budget" });
  if (a.failed) throw new Error("WITHIN-BUDGET transfer unexpectedly FAILED at "+a.where+": "+JSON.stringify(a.err).slice(0,400));
  const a1r = await balance(recipient);
  console.log("A) within-budget 800000 SETTLED tx=%s recipient delta=%s", a.hash, (a1r-a0r).toString());
  if (a1r - a0r !== 800_000n) throw new Error("within-budget delta mismatch: "+(a1r-a0r));
  st.budgetWithinTx = a.hash; saveState(st);

  // B) exceed period budget: another 900_000 -> 800_000+900_000=1_700_000 > 1_500_000 -> REJECTED
  const b = await sessionTransfer({ st, to: recipient, amount: 900_000n, label: "exceed-budget" });
  console.log("B) exceed-budget 900000 result:", JSON.stringify(b).slice(0,300));
  if (!b.failed) throw new Error("BUDGET GUARD BROKEN: over-budget transfer settled! tx="+b.hash);
  console.log("B) BUDGET GUARD PASS: over-period-budget transfer rejected (expected, spending_limit).");
  st.budgetExceedRejected = { where: b.where, err: b.err };
  saveState(st);
  console.log("STAGE15 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
