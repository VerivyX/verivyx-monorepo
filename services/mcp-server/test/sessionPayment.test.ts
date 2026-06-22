/**
 * TDD tests for sessionPayment.ts — session-key authorized adapter.pay builder.
 *
 * Tests the ported authlib.js mechanism without any live network access.
 * The crux is test 3: signDelegated produces the correct two-entry auth tree AND
 * the session key's signature is verified non-vacuously against the recomputed hash.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Address,
  hash,
  Keypair,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import {
  ed25519SignatureScVal,
  signaturesScVal,
  signDelegated,
  buildSessionPayment,
  buildDelegatedInvocation,
  buildStandardTransferPayment,
} from "../src/wallet/sessionPayment.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
// A real testnet smart account from the spike — used as a C-address fixture.
const SMART_ACCOUNT_ID = "CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU";
// A real testnet adapter ID from the spike.
const ADAPTER_ID = "CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5";

// Generate a fresh session keypair for every test run (deterministic via a seed).
const SESSION_KP = Keypair.random();
const SESSION_PUBKEY = SESSION_KP.publicKey();
const SESSION_SECRET = SESSION_KP.secret();

// ---------------------------------------------------------------------------
// Helper: build a minimal smart-account auth entry for testing signDelegated.
// This mimics what the Soroban host returns from simulation:
//   SorobanAuthorizationEntry {
//     credentials: Address(smartAccount, nonce, exp=0, sig=void),
//     rootInvocation: adapter.pay(...),
//   }
// ---------------------------------------------------------------------------

function makeSampleSmartAccountAuthEntry(nonce: bigint = 12345678n): xdr.SorobanAuthorizationEntry {
  // Root invocation: adapter.pay(owner, domain, slug) — mirrors what the host returns.
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(ADAPTER_ID).toScAddress(),
        functionName: "pay",
        args: [
          Address.fromString(SMART_ACCOUNT_ID).toScVal(),
          xdr.ScVal.scvString("example.com"),
          xdr.ScVal.scvString("hello-world"),
        ],
      }),
    ),
    subInvocations: [],
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SMART_ACCOUNT_ID).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation,
  });
}

// ---------------------------------------------------------------------------
// Test 1: signaturesScVal structure
// ---------------------------------------------------------------------------

test("signaturesScVal: produces scvVec[ scvMap[ {key=scvVec[Symbol,Address], val=scvBytes(0)} ] ]", () => {
  const sig = signaturesScVal([SESSION_PUBKEY]);

  // Outer shape: scvVec with one element (the Signatures tuple struct)
  assert.equal(sig.switch().name, "scvVec", "outer is scvVec");
  const outerVec = sig.vec();
  assert.ok(outerVec, "outer vec not null");
  assert.equal(outerVec!.length, 1, "outer vec has 1 element (tuple struct)");

  // Inner element: scvMap
  const mapVal = outerVec![0];
  assert.equal(mapVal.switch().name, "scvMap", "inner is scvMap");
  const mapEntries = mapVal.map();
  assert.ok(mapEntries, "map entries not null");
  assert.equal(mapEntries!.length, 1, "map has 1 entry for 1 delegated signer");

  const entry = mapEntries![0];

  // Key: scvVec([ Symbol("Delegated"), Address(session) ])
  const keyVal = entry.key();
  assert.equal(keyVal.switch().name, "scvVec", "key is scvVec");
  const keyVec = keyVal.vec();
  assert.ok(keyVec, "key vec not null");
  assert.equal(keyVec!.length, 2, "key vec has 2 elements");
  assert.equal(keyVec![0].switch().name, "scvSymbol", "first key element is Symbol");
  assert.equal(
    keyVec![0].sym().toString(),
    "Delegated",
    'symbol is "Delegated"',
  );
  assert.equal(keyVec![1].switch().name, "scvAddress", "second key element is Address");
  const recoveredAddr = Address.fromScAddress(keyVec![1].address()).toString();
  assert.equal(recoveredAddr, SESSION_PUBKEY, "address matches session pubkey");

  // Value: scvBytes(len 0) — ignored by OZ for Delegated signers
  const valVal = entry.val();
  assert.equal(valVal.switch().name, "scvBytes", "val is scvBytes");
  assert.equal(valVal.bytes().length, 0, "val bytes is empty (ignored for Delegated)");
});

test("signaturesScVal: map keys are sorted (for 2 addresses)", () => {
  const kp1 = Keypair.random();
  const kp2 = Keypair.random();
  const sig = signaturesScVal([kp1.publicKey(), kp2.publicKey()]);

  const mapVal = sig.vec()![0];
  const entries = mapVal.map()!;
  assert.equal(entries.length, 2);

  // Keys must be in ascending XDR-hex order
  const hex0 = entries[0].key().toXDR("hex");
  const hex1 = entries[1].key().toXDR("hex");
  assert.ok(
    hex0.localeCompare(hex1) <= 0,
    `map keys must be sorted: ${hex0} <= ${hex1}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: ed25519SignatureScVal structure
// ---------------------------------------------------------------------------

test("ed25519SignatureScVal: produces correct scvVec[ scvMap[ {public_key, signature} ] ]", () => {
  const fakeSig = Buffer.alloc(64, 0xab); // 64 bytes
  const val = ed25519SignatureScVal(SESSION_PUBKEY, fakeSig);

  assert.equal(val.switch().name, "scvVec", "outer is scvVec");
  const vec = val.vec();
  assert.ok(vec);
  assert.equal(vec!.length, 1);

  const innerMap = vec![0];
  assert.equal(innerMap.switch().name, "scvMap");
  const entries = innerMap.map();
  assert.ok(entries);
  assert.equal(entries!.length, 2, "map has 2 entries: public_key + signature");

  // Entry 0: public_key
  const pk = entries![0];
  assert.equal(pk.key().switch().name, "scvSymbol");
  assert.equal(pk.key().sym().toString(), "public_key");
  assert.equal(pk.val().switch().name, "scvBytes");
  const pkBytes = pk.val().bytes();
  assert.equal(pkBytes.length, 32, "public_key is 32 bytes (ed25519)");
  // Verify it matches the session pubkey's ed25519 raw bytes
  const expectedPkBytes = Address.fromString(SESSION_PUBKEY).toScAddress().accountId().ed25519();
  assert.deepEqual(Buffer.from(pkBytes), Buffer.from(expectedPkBytes), "public_key bytes match");

  // Entry 1: signature
  const sig = entries![1];
  assert.equal(sig.key().switch().name, "scvSymbol");
  assert.equal(sig.key().sym().toString(), "signature");
  assert.equal(sig.val().switch().name, "scvBytes");
  assert.deepEqual(Buffer.from(sig.val().bytes()), fakeSig, "signature bytes match");
});

// ---------------------------------------------------------------------------
// Test 3: signDelegated — two-entry tree + signature verification (THE CRUX)
// ---------------------------------------------------------------------------

test("signDelegated: non-Address entry passed through unchanged", () => {
  // Build a source-account credential entry (no address cred)
  const nonAddressEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(ADAPTER_ID).toScAddress(),
          functionName: "pay",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });

  const smartAccountEntry = makeSampleSmartAccountAuthEntry();
  const result = signDelegated({
    auths: [nonAddressEntry, smartAccountEntry],
    smartAccountId: SMART_ACCOUNT_ID,
    signerSecret: SESSION_SECRET,
    networkPassphrase: NETWORK_PASSPHRASE,
    expirationLedger: 9999999,
  });

  // Should have: [nonAddressEntry (unchanged), Entry A (smart account), Entry B (delegated)]
  assert.equal(result.length, 3, "3 entries: pass-through + Entry A + Entry B");

  // First entry is the non-address one, unchanged
  assert.equal(
    result[0].credentials().switch().name,
    "sorobanCredentialsSourceAccount",
    "first entry is source-account pass-through",
  );
});

test("signDelegated: non-matching Address entry passed through unchanged", () => {
  const otherKp = Keypair.random();
  // An address credential for a G-address (not the smart account)
  const otherEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(otherKp.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString("0"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(ADAPTER_ID).toScAddress(),
          functionName: "pay",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });

  const result = signDelegated({
    auths: [otherEntry],
    smartAccountId: SMART_ACCOUNT_ID,
    signerSecret: SESSION_SECRET,
    networkPassphrase: NETWORK_PASSPHRASE,
    expirationLedger: 9999999,
  });

  // Non-matching address entry passed through unchanged, no extra entries appended
  assert.equal(result.length, 1, "only 1 entry: non-matching pass-through");
  assert.equal(
    result[0].credentials().switch().name,
    "sorobanCredentialsAddress",
  );
  const addr = Address.fromScAddress(result[0].credentials().address().address()).toString();
  assert.equal(addr, otherKp.publicKey(), "address is the non-matching G-address");
});

test("signDelegated: Entry A has expirationLedger + Signatures; Entry B has session credentials + __check_auth; SIGNATURE VERIFIED", () => {
  const EXPIRATION = 9999999;
  const NONCE = 99887766n;
  const entry = makeSampleSmartAccountAuthEntry(NONCE);

  const result = signDelegated({
    auths: [entry],
    smartAccountId: SMART_ACCOUNT_ID,
    signerSecret: SESSION_SECRET,
    networkPassphrase: NETWORK_PASSPHRASE,
    expirationLedger: EXPIRATION,
  });

  // Should produce exactly 2 entries: Entry A + Entry B
  assert.equal(result.length, 2, "2 entries produced for smart-account auth entry");

  // ---- Verify Entry A -------------------------------------------------------
  const entryA = result[0];
  assert.equal(
    entryA.credentials().switch().name,
    "sorobanCredentialsAddress",
    "Entry A credentials are Address",
  );
  const credA = entryA.credentials().address();

  // expirationLedger set
  assert.equal(
    credA.signatureExpirationLedger(),
    EXPIRATION,
    "Entry A expirationLedger set correctly",
  );

  // address is the smart account
  const addrA = Address.fromScAddress(credA.address()).toString();
  assert.equal(addrA, SMART_ACCOUNT_ID, "Entry A address is smart account");

  // nonce preserved from simulation (not mutated)
  assert.equal(
    BigInt(credA.nonce().toString()),
    NONCE,
    "Entry A nonce preserved from simulation",
  );

  // signature == signaturesScVal([session])
  const sigA = credA.signature();
  assert.equal(sigA.switch().name, "scvVec", "Entry A signature is scvVec (Signatures)");
  const outerVec = sigA.vec();
  assert.ok(outerVec && outerVec.length === 1, "Signatures outer vec length 1");
  const innerMap = outerVec![0];
  assert.equal(innerMap.switch().name, "scvMap");
  const mapEntries = innerMap.map()!;
  assert.equal(mapEntries.length, 1, "1 signer in Signatures map");
  // key = scvVec([ Symbol("Delegated"), Address(session) ])
  const keyVec = mapEntries[0].key().vec()!;
  assert.equal(keyVec[0].sym().toString(), "Delegated");
  const delegatedAddr = Address.fromScAddress(keyVec[1].address()).toString();
  assert.equal(delegatedAddr, SESSION_PUBKEY, "Delegated signer is session pubkey");
  // val = scvBytes(len 0)
  assert.equal(mapEntries[0].val().bytes().length, 0, "Delegated val is empty bytes");

  // ---- Verify Entry B -------------------------------------------------------
  const entryB = result[1];
  assert.equal(
    entryB.credentials().switch().name,
    "sorobanCredentialsAddress",
    "Entry B credentials are Address",
  );
  const credB = entryB.credentials().address();

  // Entry B address is the SESSION pubkey (G-address)
  const addrB = Address.fromScAddress(credB.address()).toString();
  assert.equal(addrB, SESSION_PUBKEY, "Entry B address is session pubkey");

  // Entry B expirationLedger
  assert.equal(
    credB.signatureExpirationLedger(),
    EXPIRATION,
    "Entry B expirationLedger matches",
  );

  // Entry B rootInvocation: __check_auth on smart account
  const invB = entryB.rootInvocation();
  assert.equal(
    invB.function().switch().name,
    "sorobanAuthorizedFunctionTypeContractFn",
  );
  const fnArgs = invB.function().contractFn();
  const contractAddr = Address.fromScAddress(fnArgs.contractAddress()).toString();
  assert.equal(contractAddr, SMART_ACCOUNT_ID, "Entry B invokes smart account");
  assert.equal(
    fnArgs.functionName().toString(),
    "__check_auth",
    'Entry B function name is "__check_auth"',
  );
  assert.equal(fnArgs.args().length, 1, "__check_auth has 1 arg (signaturePayload)");
  const payloadArg = fnArgs.args()[0];
  assert.equal(payloadArg.switch().name, "scvBytes", "payload arg is scvBytes");
  const embeddedPayload = Buffer.from(payloadArg.bytes());
  assert.equal(embeddedPayload.length, 32, "payload is a 32-byte SHA-256 hash");

  // Entry B subInvocations is empty
  assert.equal(invB.subInvocations().length, 0, "Entry B has no subInvocations");

  // ---- SIGNATURE VERIFICATION (non-vacuous) ---------------------------------
  // Recompute the delegated payload hash from Entry B's preimage and verify the
  // session key actually signed the right thing.
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));
  const delegatedNonceB = credB.nonce();

  const recomputedPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: delegatedNonceB,
      signatureExpirationLedger: EXPIRATION,
      invocation: invB,
    }),
  );
  const recomputedPayloadHash = hash(recomputedPreimage.toXDR());

  // Extract the signature bytes from Entry B's ed25519 sig ScVal
  const sigBScVal = credB.signature();
  // sigB is ed25519SignatureScVal: scvVec([ scvMap([ {public_key, signature} ]) ])
  assert.equal(sigBScVal.switch().name, "scvVec");
  const sigBMap = sigBScVal.vec()![0].map()!;
  // "signature" is the second entry (index 1)
  const sigBytes = Buffer.from(sigBMap[1].val().bytes());
  assert.equal(sigBytes.length, 64, "ed25519 signature is 64 bytes");

  // Verify: Keypair.fromPublicKey(session).verify(payloadHash, sig) must be true
  const verified = Keypair.fromPublicKey(SESSION_PUBKEY).verify(recomputedPayloadHash, sigBytes);
  assert.ok(verified, "SESSION KEY SIGNATURE VERIFIED: session key signed the correct payload hash");

  // Also verify the payload arg embedded in Entry B matches the smart account's preimage hash
  // (the sa preimage = hash(SA nonce + exp + rootInvocation from Entry A))
  const saPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: credA.nonce(), // Entry A nonce (from simulation)
      signatureExpirationLedger: EXPIRATION,
      invocation: entryA.rootInvocation(),
    }),
  );
  const saPayloadHash = hash(saPreimage.toXDR());
  assert.deepEqual(
    embeddedPayload,
    saPayloadHash,
    "__check_auth arg matches smart account signature payload hash",
  );
});

// ---------------------------------------------------------------------------
// Test 4: buildSessionPayment with injected simulate
// ---------------------------------------------------------------------------

test("buildSessionPayment: injected simulate → tx XDR decodes to invokeHostFunction op with correct args + auth tree", async () => {
  const EXPIRATION_BASE = 1000; // latestLedger from injected simulate
  const NONCE = 55443322n;
  const DOMAIN = "testsite.com";
  const SLUG = "article-one";

  // Build a canned smart-account auth entry (as simulation would return)
  const cannedAuth = makeSampleSmartAccountAuthEntry(NONCE);

  // Injected simulate: returns the canned auth + latestLedger, ignores the tx XDR
  const injectSimulate = async (_txXdr: string) => ({
    auth: [cannedAuth],
    latestLedger: EXPIRATION_BASE,
  });

  const txXdr = await buildSessionPayment({
    adapterId: ADAPTER_ID,
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    domain: DOMAIN,
    slug: SLUG,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org", // not used with injected simulate
    simulate: injectSimulate,
  });

  assert.ok(typeof txXdr === "string" && txXdr.length > 0, "returned non-empty XDR string");

  // Decode the returned XDR
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;

  // Should have exactly 1 operation
  assert.equal(tx.operations.length, 1, "tx has exactly 1 operation");
  const op = tx.operations[0];
  assert.equal(op.type, "invokeHostFunction", "operation type is invokeHostFunction");

  // Cast to access auth — read from the raw XDR envelope
  const env = tx.toEnvelope();
  const invokeOp = env.v1().tx().operations()[0].body().invokeHostFunctionOp();

  // Verify the host function args
  const hostFn = invokeOp.hostFunction();
  assert.equal(
    hostFn.switch().name,
    "hostFunctionTypeInvokeContract",
    "host function type is invokeContract",
  );
  const contractArgs = hostFn.invokeContract();
  const calledContract = Address.fromScAddress(contractArgs.contractAddress()).toString();
  assert.equal(calledContract, ADAPTER_ID, "invokes adapter contract");
  assert.equal(contractArgs.functionName().toString(), "pay", 'function name is "pay"');

  const args = contractArgs.args();
  assert.equal(args.length, 3, "pay has 3 args: [owner, domain, slug]");

  // Arg 0: owner = smartAccountId (as Address ScVal)
  assert.equal(args[0].switch().name, "scvAddress", "arg[0] is Address");
  const ownerAddr = Address.fromScAddress(args[0].address()).toString();
  assert.equal(ownerAddr, SMART_ACCOUNT_ID, "arg[0] owner == smartAccountId");

  // Arg 1: domain (string ScVal)
  assert.equal(args[1].switch().name, "scvString", "arg[1] is String (domain)");
  assert.equal(args[1].str().toString(), DOMAIN, "arg[1] domain matches");

  // Arg 2: slug (string ScVal)
  assert.equal(args[2].switch().name, "scvString", "arg[2] is String (slug)");
  assert.equal(args[2].str().toString(), SLUG, "arg[2] slug matches");

  // Verify the auth tree attached to the op
  const authEntries = invokeOp.auth();
  assert.equal(authEntries.length, 2, "op has 2 auth entries (Entry A + Entry B)");

  // Entry A: smart account
  const eA = authEntries[0];
  assert.equal(eA.credentials().switch().name, "sorobanCredentialsAddress");
  const addrA = Address.fromScAddress(eA.credentials().address().address()).toString();
  assert.equal(addrA, SMART_ACCOUNT_ID, "Entry A is smart account");
  assert.equal(
    eA.credentials().address().signatureExpirationLedger(),
    EXPIRATION_BASE + 100,
    "Entry A expiration = latestLedger + 100",
  );

  // Entry B: session key / delegated
  const eB = authEntries[1];
  assert.equal(eB.credentials().switch().name, "sorobanCredentialsAddress");
  const addrB = Address.fromScAddress(eB.credentials().address().address()).toString();
  assert.equal(addrB, SESSION_PUBKEY, "Entry B is session pubkey");
  assert.equal(
    eB.rootInvocation().function().contractFn().functionName().toString(),
    "__check_auth",
    "Entry B rootInvocation is __check_auth",
  );
});

// ---------------------------------------------------------------------------
// Test 5: buildDelegatedInvocation — op-agnostic builder (underlying core)
// ---------------------------------------------------------------------------

// Fixture: USDC contract (testnet SAC from the spike findings)
const USDC_CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
// Fixture: payTo G-address (fresh trustlined recipient from the spike)
const PAY_TO = "GBJFBJYNVBKAH7X2ZC6WWVSVUUVZZMLOWE4F7OL22W6ENJABI7I2H2ML";
// Fixture: amount = 0.1 USDC (1_000_000 stroops per USDC)
const TRANSFER_AMOUNT = 1_000_000n;

/**
 * Build a canned smart-account auth entry for a USDC.transfer invocation.
 * Mimics what the Soroban host returns from simulating transfer(from=SA, to=payTo, amount).
 */
function makeTransferAuthEntry(nonce: bigint = 77665544n): xdr.SorobanAuthorizationEntry {
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(USDC_CONTRACT_ID).toScAddress(),
        functionName: "transfer",
        args: [
          Address.fromString(SMART_ACCOUNT_ID).toScVal(),
          Address.fromString(PAY_TO).toScVal(),
          xdr.ScVal.scvI128(new xdr.Int128Parts({
            hi: xdr.Int64.fromString("0"),
            lo: xdr.Uint64.fromString(TRANSFER_AMOUNT.toString()),
          })),
        ],
      }),
    ),
    subInvocations: [],
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SMART_ACCOUNT_ID).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation,
  });
}

test("buildDelegatedInvocation: parameterized op → tx XDR with correct contract + function + args + two-entry auth tree", async () => {
  const EXPIRATION_BASE = 2000;
  const NONCE = 77665544n;

  const cannedAuth = makeTransferAuthEntry(NONCE);
  const injectSimulate = async (_txXdr: string) => ({
    auth: [cannedAuth],
    latestLedger: EXPIRATION_BASE,
  });

  // Transfer args: from=SA, to=payTo, amount (i128)
  const transferArgs: xdr.ScVal[] = [
    Address.fromString(SMART_ACCOUNT_ID).toScVal(),
    Address.fromString(PAY_TO).toScVal(),
    xdr.ScVal.scvI128(new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(TRANSFER_AMOUNT.toString()),
    })),
  ];

  const txXdr = await buildDelegatedInvocation({
    contractId: USDC_CONTRACT_ID,
    functionName: "transfer",
    args: transferArgs,
    smartAccountId: SMART_ACCOUNT_ID,
    sessionSecret: SESSION_SECRET,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    simulate: injectSimulate,
  });

  assert.ok(typeof txXdr === "string" && txXdr.length > 0, "returned non-empty XDR string");

  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  assert.equal(tx.operations.length, 1, "tx has exactly 1 operation");
  assert.equal(tx.operations[0].type, "invokeHostFunction", "operation type is invokeHostFunction");

  const env = tx.toEnvelope();
  const invokeOp = env.v1().tx().operations()[0].body().invokeHostFunctionOp();

  // Verify host function: invokeContract calling USDC.transfer
  const hostFn = invokeOp.hostFunction();
  assert.equal(hostFn.switch().name, "hostFunctionTypeInvokeContract");
  const contractArgs = hostFn.invokeContract();
  const calledContract = Address.fromScAddress(contractArgs.contractAddress()).toString();
  assert.equal(calledContract, USDC_CONTRACT_ID, "invokes USDC contract");
  assert.equal(contractArgs.functionName().toString(), "transfer", 'function name is "transfer"');

  const args = contractArgs.args();
  assert.equal(args.length, 3, "transfer has 3 args: [from, to, amount]");

  // Arg 0: from = smartAccountId
  assert.equal(args[0].switch().name, "scvAddress", "arg[0] is Address (from)");
  const fromAddr = Address.fromScAddress(args[0].address()).toString();
  assert.equal(fromAddr, SMART_ACCOUNT_ID, "arg[0] from == smartAccountId");

  // Arg 1: to = payTo
  assert.equal(args[1].switch().name, "scvAddress", "arg[1] is Address (to)");
  const toAddr = Address.fromScAddress(args[1].address()).toString();
  assert.equal(toAddr, PAY_TO, "arg[1] to == payTo");

  // Arg 2: amount (i128)
  assert.equal(args[2].switch().name, "scvI128", "arg[2] is i128 (amount)");
  const amountLo = BigInt(args[2].i128().lo().toString());
  assert.equal(amountLo, TRANSFER_AMOUNT, "arg[2] amount matches");

  // Verify two-entry auth tree
  const authEntries = invokeOp.auth();
  assert.equal(authEntries.length, 2, "op has 2 auth entries (Entry A + Entry B)");

  // Entry A: smart account
  const eA = authEntries[0];
  assert.equal(eA.credentials().switch().name, "sorobanCredentialsAddress");
  const addrA = Address.fromScAddress(eA.credentials().address().address()).toString();
  assert.equal(addrA, SMART_ACCOUNT_ID, "Entry A is smart account");
  assert.equal(
    eA.credentials().address().signatureExpirationLedger(),
    EXPIRATION_BASE + 100,
    "Entry A expiration = latestLedger + 100",
  );

  // Entry B: session key / delegated
  const eB = authEntries[1];
  assert.equal(eB.credentials().switch().name, "sorobanCredentialsAddress");
  const addrB = Address.fromScAddress(eB.credentials().address().address()).toString();
  assert.equal(addrB, SESSION_PUBKEY, "Entry B is session pubkey");
  assert.equal(
    eB.rootInvocation().function().contractFn().functionName().toString(),
    "__check_auth",
    "Entry B rootInvocation is __check_auth",
  );
  // Entry B targets the smart account contract
  const entryBContractAddr = Address.fromScAddress(
    eB.rootInvocation().function().contractFn().contractAddress()
  ).toString();
  assert.equal(entryBContractAddr, SMART_ACCOUNT_ID, "Entry B __check_auth targets smart account");
});

// ---------------------------------------------------------------------------
// Test 6: buildStandardTransferPayment — standard x402 exact-scheme transfer
// ---------------------------------------------------------------------------

test("buildStandardTransferPayment: USDC.transfer(SA → payTo, amount) with delegated two-entry auth tree", async () => {
  const EXPIRATION_BASE = 3000;
  const NONCE = 99001122n;
  const AMOUNT_STR = "500000"; // 0.05 USDC

  const cannedAuth = makeTransferAuthEntry(NONCE);
  const injectSimulate = async (_txXdr: string) => ({
    auth: [cannedAuth],
    latestLedger: EXPIRATION_BASE,
  });

  const txXdr = await buildStandardTransferPayment({
    usdcContractId: USDC_CONTRACT_ID,
    smartAccountId: SMART_ACCOUNT_ID,
    payTo: PAY_TO,
    amount: AMOUNT_STR,
    sessionSecret: SESSION_SECRET,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: "https://soroban-testnet.stellar.org",
    simulate: injectSimulate,
  });

  assert.ok(typeof txXdr === "string" && txXdr.length > 0, "returned non-empty XDR string");

  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  assert.equal(tx.operations.length, 1, "tx has exactly 1 operation");
  assert.equal(tx.operations[0].type, "invokeHostFunction", "operation is invokeHostFunction");

  const env = tx.toEnvelope();
  const invokeOp = env.v1().tx().operations()[0].body().invokeHostFunctionOp();

  // Verify: invokeContract targeting USDC, function "transfer"
  const hostFn = invokeOp.hostFunction();
  assert.equal(hostFn.switch().name, "hostFunctionTypeInvokeContract");
  const contractArgs = hostFn.invokeContract();
  const calledContract = Address.fromScAddress(contractArgs.contractAddress()).toString();
  assert.equal(calledContract, USDC_CONTRACT_ID, "calls USDC contract");
  assert.equal(contractArgs.functionName().toString(), "transfer", 'function is "transfer"');

  // Verify args: [from=SA (Address), to=payTo (Address), amount (i128)]
  const args = contractArgs.args();
  assert.equal(args.length, 3, "transfer takes 3 args");

  assert.equal(args[0].switch().name, "scvAddress", "arg[0] is Address");
  const fromAddr = Address.fromScAddress(args[0].address()).toString();
  assert.equal(fromAddr, SMART_ACCOUNT_ID, "arg[0] from == smartAccountId");

  assert.equal(args[1].switch().name, "scvAddress", "arg[1] is Address");
  const toAddr = Address.fromScAddress(args[1].address()).toString();
  assert.equal(toAddr, PAY_TO, "arg[1] to == payTo");

  assert.equal(args[2].switch().name, "scvI128", "arg[2] is i128");
  const amountI128Lo = BigInt(args[2].i128().lo().toString());
  assert.equal(amountI128Lo, BigInt(AMOUNT_STR), "arg[2] amount matches (low bits)");
  const amountI128Hi = BigInt(args[2].i128().hi().toString());
  assert.equal(amountI128Hi, 0n, "arg[2] amount hi bits are 0 (small amount)");

  // Verify two-entry auth tree (same structure as adapter.pay)
  const authEntries = invokeOp.auth();
  assert.equal(authEntries.length, 2, "op has 2 auth entries: Entry A (SA) + Entry B (session)");

  // Entry A: smart account credential
  const eA = authEntries[0];
  assert.equal(eA.credentials().switch().name, "sorobanCredentialsAddress");
  const eAAddr = Address.fromScAddress(eA.credentials().address().address()).toString();
  assert.equal(eAAddr, SMART_ACCOUNT_ID, "Entry A address is smart account");
  assert.equal(
    eA.credentials().address().signatureExpirationLedger(),
    EXPIRATION_BASE + 100,
    "Entry A expirationLedger = latestLedger + 100",
  );
  // Entry A signature is the Signatures map with the Delegated session signer
  const sigA = eA.credentials().address().signature();
  assert.equal(sigA.switch().name, "scvVec", "Entry A signature is Signatures scvVec");
  const sigAMap = sigA.vec()![0].map()!;
  assert.equal(sigAMap.length, 1, "Signatures map has 1 Delegated entry");
  const sigAKeyVec = sigAMap[0].key().vec()!;
  assert.equal(sigAKeyVec[0].sym().toString(), "Delegated", "Signatures key is Delegated");
  const delegatedSignerAddr = Address.fromScAddress(sigAKeyVec[1].address()).toString();
  assert.equal(delegatedSignerAddr, SESSION_PUBKEY, "Delegated signer is session pubkey");

  // Entry B: session-key credential with __check_auth rootInvocation
  const eB = authEntries[1];
  assert.equal(eB.credentials().switch().name, "sorobanCredentialsAddress");
  const eBAddr = Address.fromScAddress(eB.credentials().address().address()).toString();
  assert.equal(eBAddr, SESSION_PUBKEY, "Entry B address is session pubkey");
  assert.equal(
    eB.rootInvocation().function().contractFn().functionName().toString(),
    "__check_auth",
    "Entry B rootInvocation is __check_auth",
  );
  const eBContractAddr = Address.fromScAddress(
    eB.rootInvocation().function().contractFn().contractAddress()
  ).toString();
  assert.equal(eBContractAddr, SMART_ACCOUNT_ID, "Entry B __check_auth targets smart account");

  // Verify the __check_auth arg (the SA signature payload hash — 32 bytes)
  const checkAuthArgs = eB.rootInvocation().function().contractFn().args();
  assert.equal(checkAuthArgs.length, 1, "__check_auth has 1 arg");
  assert.equal(checkAuthArgs[0].switch().name, "scvBytes", "__check_auth arg is bytes");
  assert.equal(checkAuthArgs[0].bytes().length, 32, "__check_auth arg is 32-byte hash");
});
