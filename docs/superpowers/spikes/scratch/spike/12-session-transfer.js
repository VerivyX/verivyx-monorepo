"use strict";
// Stage 12 — THE CRUX of the standard-transfer spike.
// Build a STANDARD x402 exact-scheme USDC.transfer(from=smartAccount, to=payTo, amount),
// authorize it with the SESSION key ONLY via signDelegated (smart account is the `from`/auth
// address), submit, and verify the recipient's USDC increased and the SA's decreased.
//
// This is the unmodified x402 transfer shape any facilitator would settle; the OZ
// delegated session-key auth is attached and validated on-chain at settle.
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
  if (S.rpc.Api.isSimulationError(sim)) throw new Error("balance sim " + addr + ": " + sim.error);
  return BigInt(scValToNative(sim.result.retval).toString());
}

// Build + session-sign + submit a USDC.transfer(from=SA, to, amount). Returns {failed, hash, err}.
async function sessionTransfer({ st, signerSecret, to, amount, label }) {
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);
  const sa = st.smartAccountId;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100;

  // STANDARD x402 exact-scheme transfer: USDC.transfer(from, to, amount)
  const op = Operation.invokeContractFunction({
    contract: USDC, function: "transfer",
    args: [
      new Address(sa).toScVal(),                       // from = smart account
      new Address(to).toScVal(),                       // to   = payTo (resource recipient)
      nativeToScVal(amount.toString(), { type: "i128" }),
    ],
  });

  // simulate (no auth) to discover the smart-account auth entry the host wants
  let acc = await loadAccount(deployer.publicKey());
  let tx = new S.TransactionBuilder(acc, { fee: "8000000", networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) return { failed: true, where: "sim", err: sim.error };
  const auths = (sim.result?.auth || []).map(a => typeof a === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(a, "base64") : a);
  console.log(`[${label}] auth entries: ${auths.length} (transfer requires the SA's auth as \`from\`)`);

  // session-sign the smart-account auth entry (signDelegated UNCHANGED — transfer is just another call)
  const signed = signDelegated({ auths, smartAccountId: sa, signerSecret, networkPassphrase: NET, expirationLedger: expiration });

  acc = await loadAccount(deployer.publicKey());
  let tx2 = new S.TransactionBuilder(acc, { fee: "12000000", networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  { const env = tx2.toEnvelope(); env.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signed); tx2 = new S.Transaction(env, NET); }
  const sim2 = await server.simulateTransaction(tx2);
  if (S.rpc.Api.isSimulationError(sim2)) return { failed: true, where: "resim", err: sim2.error };
  let prepared = S.rpc.assembleTransaction(tx2, sim2).build();
  { const env2 = prepared.toEnvelope(); const b2 = env2.v1().tx().operations()[0].body().invokeHostFunctionOp(); if (b2.auth().length === 0) { b2.auth(signed); prepared = new S.Transaction(env2, NET); } }
  prepared.sign(deployer);

  // Capture the standard x402 payload shape: the assembled tx envelope XDR with the delegated auth attached.
  const payloadXdr = prepared.toEnvelope().toXDR("base64");

  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") return { failed: true, where: "send", err: send.errorResult?.toXDR?.("base64") || JSON.stringify(send) };
  let got = await server.getTransaction(send.hash);
  const dl = Date.now() + 90000;
  while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) { await new Promise(r=>setTimeout(r,2000)); got = await server.getTransaction(send.hash); }
  if (got.status !== "SUCCESS") return { failed: true, where: "tx", err: got.status, hash: send.hash, resultXdr: got.resultXdr?.toXDR?.("base64") };
  return { failed: false, hash: send.hash, payloadXdr };
}

(async () => {
  const st = loadState();
  const sa = st.smartAccountId;
  const recipient = st.keys.RECIPIENT.pub;
  const amount = 1_000_000n; // 0.1 USDC — a sample x402 resource price

  const beforeSA = await balance(sa);
  const beforeR = await balance(recipient);
  console.log("BEFORE: SA=%s recipient=%s", beforeSA, beforeR);

  const res = await sessionTransfer({ st, signerSecret: st.keys.SESSION.sec, to: recipient, amount, label: "session-transfer" });
  if (res.failed) throw new Error(`CORE transfer FAILED at ${res.where}: ${JSON.stringify(res.err).slice(0,500)}`);
  console.log("STANDARD SESSION TRANSFER SETTLED tx =", res.hash);
  st.transferTx = res.hash;
  st.transferPayloadXdrLen = res.payloadXdr?.length;
  saveState(st);

  const afterSA = await balance(sa);
  const afterR = await balance(recipient);
  console.log("AFTER:  SA=%s recipient=%s", afterSA, afterR);

  const dSA = afterSA - beforeSA;
  const dR = afterR - beforeR;
  console.log("DELTA:  SA=%s recipient=%s (expected SA -%s, recipient +%s)", dSA, dR, amount, amount);
  st.transferDeltas = { sa: dSA.toString(), recipient: dR.toString(), amount: amount.toString() };
  saveState(st);

  if (dR !== amount) throw new Error(`recipient delta mismatch: got ${dR} want ${amount}`);
  if (dSA !== -amount) throw new Error(`SA delta mismatch: got ${dSA} want ${-amount}`);
  console.log("VERIFIED: recipient +%s, SA -%s — standard non-custodial x402 transfer settled via session key.", amount, amount);
  console.log("STAGE12 done");
})().catch(e => { console.error("FAIL", e.stack || e.message || e); process.exit(1); });
