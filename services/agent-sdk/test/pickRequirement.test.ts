import assert from "node:assert/strict";
import { test } from "node:test";
import { PaywallAgent } from "../src/agent.js";
import { NoMatchingRequirementError } from "../src/errors.js";
import type { PaymentRequirement } from "../src/types.js";

function agent(): PaywallAgent {
  return new PaywallAgent({
    apiBase: "https://api.verivyx.test",
    network: "stellar:testnet",
    // signer is unused by pickRequirement; a stub satisfies the constructor.
    signer: (async () => "") as never,
  });
}

const soroban: PaymentRequirement = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // no ':'
  payTo: "CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH",
  amount: "50000",
  maxTimeoutSeconds: 120,
} as PaymentRequirement;

const classic: PaymentRequirement = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", // has ':'
  payTo: "GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X",
  amount: "50000",
  maxTimeoutSeconds: 120,
} as PaymentRequirement;

test("prefers the classic Stellar USDC entry even when Soroban is listed first", () => {
  const picked = agent().pickRequirement([soroban, classic]);
  assert.equal(picked.asset, classic.asset);
});

test("falls back to the only exact-on-network entry when no classic exists", () => {
  const picked = agent().pickRequirement([soroban]);
  assert.equal(picked.asset, soroban.asset);
});

test("throws when nothing matches scheme=exact on the agent network", () => {
  const wrongNetwork = { ...classic, network: "stellar:pubnet" } as PaymentRequirement;
  const wrongScheme = { ...classic, scheme: "upto" } as unknown as PaymentRequirement;
  assert.throws(() => agent().pickRequirement([wrongNetwork, wrongScheme]), NoMatchingRequirementError);
  assert.throws(() => agent().pickRequirement([]), NoMatchingRequirementError);
});
