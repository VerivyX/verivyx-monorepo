"use strict";
// Reads the repo-root .env and writes a minimal chain.env (gitignored, under /docs/)
// containing ONLY the keys the standard-transfer spike needs. Never prints values.
const fs = require("fs");
const path = require("path");

const ROOT_ENV = path.resolve(__dirname, "../../../../../.env");
const OUT = path.join(__dirname, "chain.env");

const KEYS = [
  "STELLAR_RPC_URL",
  "USDC_CONTRACT_ID",
  "USDC_ISSUER",
  "PLATFORM_STELLAR_ADDRESS",
  "PLAYGROUND_FAUCET_SECRET",
  "VERIVYX_PAY_ADAPTER_ID",
  "SPIKE_OZ_ACCOUNT_WASM_HASH",
  "SPIKE_OZ_SMART_ACCOUNT_ID",
  "SPIKE_OZ_OWNERMASTER_SEC",
  "SPIKE_OZ_SESSION_SEC",
  "SPIKE_OZ_DEPLOYER_SEC",
  "SPIKE_OZ_CREATOR_SEC",
  "SPIKE_OZ_ATTACKER_SEC",
];

const raw = fs.readFileSync(ROOT_ENV, "utf8");
const map = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) map[m[1]] = m[2];
}
const out = [];
const missing = [];
for (const k of KEYS) {
  if (map[k] == null) { missing.push(k); continue; }
  out.push(`${k}=${map[k]}`);
}
fs.writeFileSync(OUT, out.join("\n") + "\n", { mode: 0o600 });
console.log("wrote chain.env with %d keys (missing: %s)", out.length, missing.join(",") || "none");
