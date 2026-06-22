"use strict";
const { Keypair, loadState, saveState, friendbot } = require("./lib");

(async () => {
  const st = loadState();
  const roles = ["DEPLOYER", "OWNERMASTER", "SESSION", "CREATOR", "ATTACKER"];
  st.keys = st.keys || {};
  for (const r of roles) {
    if (!st.keys[r]) {
      const k = Keypair.random();
      st.keys[r] = { pub: k.publicKey(), sec: k.secret() };
      console.log(`generated ${r} = ${k.publicKey()}`);
    } else {
      console.log(`have ${r} = ${st.keys[r].pub}`);
    }
  }
  saveState(st);
  // Fund the G-accounts that need to exist as classic accounts (fee payers + creator + attacker).
  for (const r of ["DEPLOYER", "CREATOR", "ATTACKER", "SESSION"]) {
    await friendbot(st.keys[r].pub);
    console.log(`funded ${r}`);
  }
  console.log("STAGE1 keys+funding done");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
