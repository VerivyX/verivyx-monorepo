"use strict";
// Upload OZ account WASM (if not done via CLI) and deploy an instance whose
// Default-rule signer is Delegated(OWNERMASTER).
const fs = require("fs");
const path = require("path");
const {
  Keypair, Operation, xdr, Address, server, NET,
  loadState, saveState, loadAccount, buildSimSignSubmit,
  signerDelegated, vecSigners, S,
} = require("./lib");

const WASM_PATH = "/wasm/oz_smart_account.wasm";

(async () => {
  const st = loadState();
  const deployer = Keypair.fromSecret(st.keys.DEPLOYER.sec);

  // 1) Upload WASM (idempotent: hash is deterministic).
  if (!st.accountWasmHash) {
    const wasm = fs.readFileSync(WASM_PATH);
    const acc = await loadAccount(deployer.publicKey());
    let tx = new S.TransactionBuilder(acc, { fee: "5000000", networkPassphrase: NET })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(120).build();
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) throw new Error("upload sim: " + sim.error);
    tx = S.rpc.assembleTransaction(tx, sim).build();
    tx.sign(deployer);
    const send = await server.sendTransaction(tx);
    let got = await server.getTransaction(send.hash);
    const dl = Date.now() + 60000;
    while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) {
      await new Promise(r => setTimeout(r, 2000)); got = await server.getTransaction(send.hash);
    }
    if (got.status !== "SUCCESS") throw new Error("upload tx " + got.status + " " + JSON.stringify(got.resultXdr?.toXDR?.("base64")));
    const hash = got.returnValue.bytes().toString("hex");
    st.accountWasmHash = hash;
    st.uploadTx = send.hash;
    saveState(st);
    console.log("uploaded wasm hash=", hash, "tx=", send.hash);
  } else {
    console.log("have wasm hash=", st.accountWasmHash);
  }

  // 2) Deploy instance with constructor args (signers=[Delegated(OWNERMASTER)], policies={}).
  if (!st.smartAccountId) {
    const wasmHashBuf = Buffer.from(st.accountWasmHash, "hex");
    const ownerMasterPub = st.keys.OWNERMASTER.pub;
    const ctorArgs = [
      vecSigners([signerDelegated(ownerMasterPub)]),  // Vec<Signer>
      xdr.ScVal.scvMap([]),                            // Map<Address, Val> policies
    ];
    const acc = await loadAccount(deployer.publicKey());
    const salt = require("crypto").randomBytes(32);
    let tx = new S.TransactionBuilder(acc, { fee: "5000000", networkPassphrase: NET })
      .addOperation(Operation.createCustomContract({
        address: new Address(deployer.publicKey()),
        wasmHash: wasmHashBuf,
        salt,
        constructorArgs: ctorArgs,
      }))
      .setTimeout(120).build();
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) throw new Error("deploy sim: " + sim.error);
    tx = S.rpc.assembleTransaction(tx, sim).build();
    tx.sign(deployer);
    const send = await server.sendTransaction(tx);
    let got = await server.getTransaction(send.hash);
    const dl = Date.now() + 60000;
    while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) {
      await new Promise(r => setTimeout(r, 2000)); got = await server.getTransaction(send.hash);
    }
    if (got.status !== "SUCCESS") throw new Error("deploy tx " + got.status + " " + JSON.stringify(got.resultXdr?.toXDR?.("base64")));
    const cid = Address.fromScVal(got.returnValue).toString();
    st.smartAccountId = cid;
    st.deployTx = send.hash;
    saveState(st);
    console.log("deployed smart account =", cid, "tx=", send.hash);
  } else {
    console.log("have smart account =", st.smartAccountId);
  }
  console.log("STAGE2 done");
})().catch(e => { console.error("FAIL", e.message || e); process.exit(1); });
