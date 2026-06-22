// Read USDC (SAC) balances for the E2E parties via simulate(balance).
import * as S from "@stellar/stellar-sdk";
const { Keypair, Address, Operation, TransactionBuilder, Networks, rpc, scValToNative } = S;

const RPC = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const USDC = process.env.USDC_CONTRACT_ID;
const SRC = process.env.SRC_SEC; // any funded account to source the sim
const NET = Networks.TESTNET;
const server = new rpc.Server(RPC, { allowHttp: RPC.startsWith("http://") });

const parties = {
  smartAccount: "CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU",
  creator: "GBGZH3WU3RLHHR2J626CYFFVUD5KQKIOVMWJ3HE6BE44TMUZQSFKXCIN",
  platform_and_feeTreasury: "GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X",
  paywallContract: "CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH",
};

async function bal(addr) {
  const kp = Keypair.fromSecret(SRC);
  const acc = await server.getAccount(kp.publicKey());
  const op = Operation.invokeContractFunction({
    contract: USDC, function: "balance", args: [new Address(addr).toScVal()],
  });
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return `ERR:${sim.error}`;
  return scValToNative(sim.result.retval).toString();
}

const out = {};
for (const [k, v] of Object.entries(parties)) out[k] = await bal(v);
console.log(JSON.stringify(out, null, 2));
