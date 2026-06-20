"use strict";
// Stage 3: register test domain via facilitator/keeper, add USDC trustline to CREATOR,
// fund the smart account with USDC (from faucet) and XLM (for fee reserves not needed since deployer is fee payer).
const {
  Keypair, Operation, xdr, Address, server, NET, S,
  loadState, saveState, loadAccount, buildSimSignSubmit, nativeToScVal, scValToNative,
} = require("./lib");
const Asset = S.Asset;

const USDC_CONTRACT_ID = process.env.USDC_CONTRACT_ID;
const USDC_ISSUER = process.env.USDC_ISSUER;
const PAYWALL = process.env.SOROBAN_PAYWALL_CONTRACT_ID;
const FACILITATOR_SEC = process.env.FACILITATOR_STELLAR_SECRET;
const FAUCET_SEC = process.env.PLAYGROUND_FAUCET_SECRET;

const DOMAIN = process.env.SPIKE_DOMAIN || "oz-spike-test.example";
const SLUG = "spike-article";
const PRICE = 500000;        // 0.05 USDC
const PLATFORM_FEE = 10000;  // 0.001 USDC

(async () => {
  const st = loadState();
  st.config = { USDC_CONTRACT_ID, USDC_ISSUER, PAYWALL, DOMAIN, SLUG, PRICE, PLATFORM_FEE };
  const creator = Keypair.fromSecret(st.keys.CREATOR.sec);

  // 1) CREATOR trustline to USDC classic asset (G-account holding SAC needs trustline).
  if (!st.creatorTrustline) {
    const usdcAsset = new Asset("USDC", USDC_ISSUER);
    const acc = await loadAccount(creator.publicKey());
    const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
      .addOperation(Operation.changeTrust({ asset: usdcAsset }))
      .setTimeout(120).build();
    tx.sign(creator);
    const send = await server.sendTransaction(tx);
    let got = await server.getTransaction(send.hash);
    const dl = Date.now() + 60000;
    while ((got.status === "NOT_FOUND" || got.status === "PENDING") && Date.now() < dl) { await new Promise(r=>setTimeout(r,2000)); got = await server.getTransaction(send.hash); }
    if (got.status !== "SUCCESS") throw new Error("trustline " + got.status);
    st.creatorTrustline = send.hash; saveState(st);
    console.log("CREATOR trustline ok", send.hash);
  } else console.log("CREATOR trustline have");

  // 2) register_by_keeper(domain, creator, price, platform_fee) signed by facilitator.
  if (!st.domainRegistered) {
    const op = Operation.invokeContractFunction({
      contract: PAYWALL,
      function: "register_by_keeper",
      args: [
        nativeToScVal(DOMAIN, { type: "string" }),
        new Address(creator.publicKey()).toScVal(),
        nativeToScVal(PRICE, { type: "i128" }),
        nativeToScVal(PLATFORM_FEE, { type: "i128" }),
      ],
    });
    const r = await buildSimSignSubmit({ sourceSecret: FACILITATOR_SEC, op, label: "register_by_keeper" });
    st.domainRegistered = r.hash; saveState(st);
    console.log("domain registered", r.hash);
  } else console.log("domain registered have");

  // 3) verify get_creator
  {
    const op = Operation.invokeContractFunction({
      contract: PAYWALL, function: "get_creator",
      args: [nativeToScVal(DOMAIN, { type: "string" })],
    });
    const kp = Keypair.fromSecret(st.keys.DEPLOYER.sec);
    const acc = await loadAccount(kp.publicKey());
    const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) throw new Error("get_creator sim: " + sim.error);
    const val = scValToNative(sim.result.retval);
    console.log("get_creator =>", JSON.stringify(val, (k,v)=> typeof v==="bigint"? v.toString(): v));
  }

  // 4) Fund the smart account with USDC from faucet: transfer(faucet -> smartAccount, amount).
  //    Contract addresses hold SAC balances without a trustline.
  if (!st.smartAccountFunded) {
    const faucet = Keypair.fromSecret(FAUCET_SEC);
    const amount = 5_000_000; // 0.5 USDC — enough for 2x pay(price+platform+fee) with headroom
    const op = Operation.invokeContractFunction({
      contract: USDC_CONTRACT_ID,
      function: "transfer",
      args: [
        new Address(faucet.publicKey()).toScVal(),
        new Address(st.smartAccountId).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ],
    });
    const r = await buildSimSignSubmit({ sourceSecret: FAUCET_SEC, op, label: "fund-smart-account-usdc" });
    st.smartAccountFunded = { hash: r.hash, amount }; saveState(st);
    console.log("funded smart account USDC", r.hash);
  } else console.log("smart account USDC funded have");

  // 5) read smart account USDC balance
  {
    const op = Operation.invokeContractFunction({
      contract: USDC_CONTRACT_ID, function: "balance",
      args: [new Address(st.smartAccountId).toScVal()],
    });
    const kp = Keypair.fromSecret(st.keys.DEPLOYER.sec);
    const acc = await loadAccount(kp.publicKey());
    const tx = new S.TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) throw new Error("balance sim: " + sim.error);
    console.log("smartAccount USDC balance =", scValToNative(sim.result.retval).toString());
  }
  console.log("STAGE3 done");
})().catch(e => { console.error("FAIL", e.message || e); process.exit(1); });
