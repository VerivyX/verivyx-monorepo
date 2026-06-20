"use strict";
// Probe: simulate a smart-account self-call (add_context_rule) and dump the
// SorobanAuthorizationEntry tree the host says it needs. This reveals the exact
// nested credential structure (smart account Address cred + Delegated sub-auth).
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, loadAccount, nativeToScVal,
  signerDelegated, ctxCallContract, optU32, vecSigners,
} = require("./lib");

(async () => {
  const st = loadState();
  const ADAPTER = process.env.VERIVYX_PAY_ADAPTER_ID;
  const sa = st.smartAccountId;
  const sessionPub = st.keys.SESSION.pub;

  // current ledger for valid_until
  const latest = await server.getLatestLedger();
  const validUntil = latest.sequence + 200; // ~16 min

  // add_context_rule(context_type, name, valid_until, signers, policies)
  const op = Operation.invokeContractFunction({
    contract: sa,
    function: "add_context_rule",
    args: [
      ctxCallContract(ADAPTER),
      nativeToScVal("verivyx-session", { type: "string" }),
      optU32(validUntil),
      vecSigners([signerDelegated(sessionPub)]),
      xdr.ScVal.scvMap([]),
    ],
  });

  const kp = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const acc = await loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: "2000000", networkPassphrase: NET })
    .addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) { console.error("SIM ERROR:", sim.error); process.exit(1); }

  const auths = sim.result?.auth || [];
  console.log("num auth entries:", auths.length);
  for (const a of auths) {
    const e = (typeof a === "string") ? xdr.SorobanAuthorizationEntry.fromXDR(a, "base64") : a;
    console.log("=== AUTH ENTRY ===");
    console.log(JSON.stringify(dumpEntry(e), null, 2));
  }
})().catch(e => { console.error("FAIL", e.stack || e); process.exit(1); });

function dumpCred(c) {
  const t = c.switch().name;
  if (t === "sorobanCredentialsSourceAccount") return { type: "sourceAccount" };
  const a = c.address();
  return {
    type: "address",
    address: S.Address.fromScAddress(a.address()).toString(),
    nonce: a.nonce().toString(),
    sigExpLedger: a.signatureExpirationLedger(),
    signatureScVal: S.scValToNative_safe ? null : describeScVal(a.signature()),
  };
}
function describeScVal(v) {
  try { return v.switch().name; } catch { return "?"; }
}
function dumpInvocation(inv) {
  const f = inv.function();
  const fn = f.switch().name;
  let target = null, name = null;
  if (fn === "sorobanAuthorizedFunctionTypeContractFn") {
    const cf = f.contractFn();
    target = S.Address.fromScAddress(cf.contractAddress()).toString();
    name = cf.functionName().toString();
  }
  return {
    fnType: fn, target, name,
    subInvocations: inv.subInvocations().map(dumpInvocation),
  };
}
function dumpEntry(e) {
  return {
    credentials: dumpCred(e.credentials()),
    rootInvocation: dumpInvocation(e.rootInvocation()),
  };
}
