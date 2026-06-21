"use strict";
// Stage 14 — deploy the OZ spending_limit Policy contract WASM (built at
// scratch/oz_policy → hash POLICY_WASM_HASH) and instantiate it, then
// add_policy it to the CallContract(USDC) transfer rule with a budget.
//
// install_param = SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }
//   serialized as ScMap (sorted keys): { period_ledgers: u32, spending_limit: i128 }
//
// add_policy requires the smart account's auth -> OWNERMASTER (Delegated on Default rule).
const fs = require("fs");
const crypto = require("crypto");
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, nativeToScVal, scValToNative,
} = require("./lib");
const { signDelegated } = require("./authlib");

const USDC = process.env.USDC_CONTRACT_ID;
const POLICY_WASM = "/w/oz_spending_limit_policy.wasm"; // mounted copy
const SPENDING_LIMIT = 1_500_000;   // 0.15 USDC budget per period
const PERIOD_LEDGERS = 100;         // ~8 min window

// SpendingLimitAccountParams struct -> ScMap (sorted keys)
function spendingLimitParams(limit, period) {
  const entries = [
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("period_ledgers"), val: nativeToScVal(period >>> 0, { type: "u32" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("spending_limit"), val: nativeToScVal(limit.toString(), { type: "i128" }) }),
  ];
  entries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));
  return xdr.ScVal.scvMap(entries);
}

async function submitDelegated({ st, op, signerSecret, label, fee = "10000000" }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 200;
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc,{fee,networkPassphrase:NET}).addOperation(op).setTimeout(180).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) return { failed:true, where:"sim", err: sim.error };
  const auths = (sim.result?.auth||[]).map(a=> typeof a==="string"? xdr.SorobanAuthorizationEntry.fromXDR(a,"base64"): a);
  const signed = signDelegated({ auths, smartAccountId: sa, signerSecret, networkPassphrase: NET, expirationLedger: expiration });
  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc,{fee,networkPassphrase:NET}).addOperation(op).setTimeout(180).build();
  { const env=tx2.toEnvelope(); env.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signed); tx2=new S.Transaction(env,NET); }
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) return { failed:true, where:"resim", err: sim2.error };
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  { const env2=prepared.toEnvelope(); const b2=env2.v1().tx().operations()[0].body().invokeHostFunctionOp(); if(b2.auth().length===0){b2.auth(signed);prepared=new S.Transaction(env2,NET);} }
  prepared.sign(deployer);
  const send = await server.sendTransaction(prepared);
  if (send.status==="ERROR") return { failed:true, where:"send", err: send.errorResult?.toXDR?.("base64") || JSON.stringify(send) };
  let got = await server.getTransaction(send.hash);
  const dl=Date.now()+90000;
  while((got.status==="NOT_FOUND"||got.status==="PENDING")&&Date.now()<dl){await new Promise(r=>setTimeout(r,2000));got=await server.getTransaction(send.hash);}
  if (got.status!=="SUCCESS") return { failed:true, where:"tx", err:got.status, hash:send.hash, resultXdr: got.resultXdr?.toXDR?.("base64") };
  return { failed:false, hash:send.hash, returnValue: got.returnValue };
}

// plain (deployer-signed) submit for upload/deploy ops that don't need SA auth
async function submitPlain({ st, op, label, fee = "20000000" }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc,{fee,networkPassphrase:NET}).addOperation(op).setTimeout(180).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`[${label}] sim: ${sim.error}`);
  let prepared = S.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(deployer);
  const send = await server.sendTransaction(prepared);
  if (send.status==="ERROR") throw new Error(`[${label}] send ERROR: ${send.errorResult?.toXDR?.("base64") || JSON.stringify(send)}`);
  let got = await server.getTransaction(send.hash);
  const dl=Date.now()+90000;
  while((got.status==="NOT_FOUND"||got.status==="PENDING")&&Date.now()<dl){await new Promise(r=>setTimeout(r,2000));got=await server.getTransaction(send.hash);}
  if (got.status!=="SUCCESS") throw new Error(`[${label}] TX ${got.status}: ${send.hash}`);
  return { hash: send.hash, returnValue: got.returnValue };
}

(async () => {
  const st = loadState();
  const sa = st.smartAccountId;

  // 1) upload policy WASM
  const wasm = fs.readFileSync(POLICY_WASM);
  const wasmHash = crypto.createHash("sha256").update(wasm).digest();
  console.log("policy wasm hash:", wasmHash.toString("hex"));
  if (!st.policyUploaded) {
    const opUpload = Operation.uploadContractWasm({ wasm });
    const rUp = await submitPlain({ st, op: opUpload, label: "upload-policy" });
    st.policyUploaded = rUp.hash; st.policyWasmHash = wasmHash.toString("hex"); saveState(st);
    console.log("uploaded policy wasm tx=", rUp.hash);
  }

  // 2) deploy a policy instance (no constructor)
  if (!st.policyContractId) {
    const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
    const salt = crypto.randomBytes(32);
    const opDeploy = Operation.createCustomContract({
      address: new Address(deployer.publicKey()),
      wasmHash,
      salt,
    });
    const rDep = await submitPlain({ st, op: opDeploy, label: "deploy-policy" });
    const policyId = scValToNative(rDep.returnValue); // scvAddress -> "C..." string
    st.policyContractId = policyId; st.policyDeployTx = rDep.hash; saveState(st);
    console.log("deployed policy instance:", policyId, "tx=", rDep.hash);
  }

  // 3) find the CallContract(USDC) rule id
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
  console.log("CallContract(USDC) rule id =", ruleId, "existing policies:", JSON.stringify(rules[0].policies||[]));

  // 4) add_policy(rule_id, policy_contract, install_param = SpendingLimitAccountParams)
  if (!st.policyAdded) {
    const opAddPolicy = Operation.invokeContractFunction({
      contract: sa, function: "add_policy",
      args: [
        nativeToScVal(ruleId, { type: "u32" }),
        new Address(st.policyContractId).toScVal(),
        spendingLimitParams(SPENDING_LIMIT, PERIOD_LEDGERS),
      ],
    });
    const rAdd = await submitDelegated({ st, op: opAddPolicy, signerSecret: st.keys.OWNERMASTER.sec, label: "add_policy" });
    if (rAdd.failed) throw new Error("add_policy FAILED at "+rAdd.where+": "+JSON.stringify(rAdd.err).slice(0,500));
    st.policyAdded = rAdd.hash; st.spendingLimit = SPENDING_LIMIT; st.periodLedgers = PERIOD_LEDGERS; saveState(st);
    console.log("add_policy done tx=", rAdd.hash, "limit=", SPENDING_LIMIT, "period=", PERIOD_LEDGERS);
  }
  console.log("STAGE14 done. policy=%s rule=%s", st.policyContractId, ruleId);
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
