"use strict";
// Shared helpers for the OZ session-key delegated adapter.pay spike.
// Manual @stellar/stellar-sdk construction (no smart-account-kit — passkey-first, unsuitable for ed25519 Delegated session signer in Node).

const fs = require("fs");
const path = require("path");
const S = require("@stellar/stellar-sdk");
const { Keypair, Address, nativeToScVal, xdr, rpc, TransactionBuilder, Operation, BASE_FEE, Networks, scValToNative } = S;

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET; // "Test SDF Network ; September 2015"
const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

const STATE_FILE = path.join(__dirname, "state.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function friendbot(pub) {
  const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`;
  const r = await fetch(url);
  const body = await r.text();
  if (!r.ok && !body.includes("op_already_exists") && !body.includes("createAccountAlreadyExist") && !body.includes("account already funded")) {
    throw new Error(`friendbot failed ${r.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

// ── ScVal encoders for stellar-accounts types ────────────────────────────────
// Signer::Delegated(Address) -> ScVal Vec[ Symbol("Delegated"), Address ]  (enum with payload)
function signerDelegated(addrStr) {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(addrStr).toScVal(),
  ]);
}
// ContextRuleType::CallContract(Address) -> Vec[ Symbol("CallContract"), Address ]
function ctxCallContract(addrStr) {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CallContract"),
    new Address(addrStr).toScVal(),
  ]);
}
// ContextRuleType::Default -> Vec[ Symbol("Default") ]
function ctxDefault() {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")]);
}
// Option<u32>
function optU32(v) {
  return v == null ? xdr.ScVal.scvVoid() : nativeToScVal(v >>> 0, { type: "u32" });
}
// Vec<Signer>
function vecSigners(arr) { return xdr.ScVal.scvVec(arr); }
// Map<Address, Val> empty
function emptyPolicies() { return xdr.ScVal.scvMap([]); }

async function loadAccount(pub) { return await server.getAccount(pub); }

// Simulate, assemble, sign with the given keypairs (envelope/source signers), submit, poll.
async function buildSimSignSubmit({ sourceSecret, op, extraSign = [], label }) {
  const kp = Keypair.fromSecret(sourceSecret);
  const acc = await loadAccount(kp.publicKey());
  let tx = new TransactionBuilder(acc, { fee: "2000000", networkPassphrase: NET })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`[${label}] SIMULATION ERROR: ${sim.error}`);
  }
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);
  for (const s of extraSign) tx.sign(Keypair.fromSecret(s));
  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") {
    throw new Error(`[${label}] SEND ERROR: ${JSON.stringify(send.errorResult?.result?.()?.switch?.() ?? send)}\n${JSON.stringify(send)}`);
  }
  let got = await server.getTransaction(send.hash);
  const deadline = Date.now() + 60000;
  while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    got = await server.getTransaction(send.hash);
  }
  if (got.status !== "SUCCESS") {
    throw new Error(`[${label}] TX ${got.status}: hash=${send.hash}\n${JSON.stringify(got.resultXdr?.toXDR?.("base64") || got, null, 2)}`);
  }
  return { hash: send.hash, result: got, returnValue: got.returnValue };
}

module.exports = {
  S, Keypair, Address, nativeToScVal, xdr, rpc, TransactionBuilder, Operation, BASE_FEE, Networks, scValToNative,
  RPC_URL, NET, server,
  loadState, saveState, friendbot, loadAccount,
  signerDelegated, ctxCallContract, ctxDefault, optU32, vecSigners, emptyPolicies,
  buildSimSignSubmit,
};
