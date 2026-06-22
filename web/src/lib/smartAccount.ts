/**
 * Smart-account wrapper — non-custodial wallet onboarding for the Verivyx MCP.
 *
 * Model: STANDARD x402 (no adapter, no approve).
 *   - Owner holds a non-custodial Freighter wallet.
 *   - An OpenZeppelin smart account (C-address) is deployed with the owner as
 *     Delegated signer on the Default rule.
 *   - The MCP issues a per-user ed25519 session key.
 *   - Owner grants the session key a budget-capped, expiry-limited context rule:
 *       add_context_rule(CallContract(USDC), validUntil, [Delegated(session)], {})
 *       add_policy(ruleId, SPENDING_LIMIT_POLICY, spendingLimitParams(budget, period))
 *   - The MCP's session key then pays via USDC.transfer non-custodially.
 *   - Revoke = owner-signed remove_context_rule(ruleId).
 *
 * ScVal encoders ported from docs/superpowers/spikes/scratch/spike/lib.js (proven on-chain).
 * Auth tree ported from docs/superpowers/spikes/scratch/spike/authlib.js (proven on-chain).
 *
 * Browser-validation TODOs (Rio must verify in a real browser with Freighter):
 *   [BV-1] Freighter signAuthEntry return shape — see signEntryWithFreighter().
 *   [BV-2] Deploy and delegate via Freighter signTransaction — see createOrConnectAccount()
 *           and submitWithOwnerAuth(). Requires real Freighter + Stellar testnet RPC.
 *   [BV-3] Passkey path — scaffold only; throws not_implemented.
 */

import {
  Address,
  authorizeEntry,
  hash,
  nativeToScVal,
  Operation,
  rpc as StellarRpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

// ── Config ────────────────────────────────────────────────────────────────────

/** Stellar network passphrase — e.g. "Test SDF Network ; September 2015" */
const STELLAR_NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'Test SDF Network ; September 2015';

/** Soroban RPC URL */
const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

/**
 * OZ smart account WASM hash (testnet, uploaded).
 * Source: docs/superpowers/specs/2026-06-21-plan3-frontend-guidance.md §Proven on-chain facts
 */
const OZ_ACCOUNT_WASM_HASH =
  process.env.NEXT_PUBLIC_OZ_ACCOUNT_WASM_HASH ??
  '40276717b7227725be75ad66ec2214aa95a29b47b36679a90f165be3f8fe09cb';

/**
 * Deployed spending_limit Policy contract address (testnet).
 * Source: standard-transfer-findings.md §policy; spike 14-deploy-policy.js.
 * One instance serves all users — install keys budget per-(policy,rule,sa).
 */
const SPENDING_LIMIT_POLICY_ADDRESS =
  process.env.NEXT_PUBLIC_SPENDING_LIMIT_POLICY_ADDRESS ??
  'CBGLHQVGQEWBWW6JJXKLLMQZL3G4ENHFRBORLAUO2ZYVAJ2EZWYVMZC2';

/** USDC SAC contract ID (testnet). */
const USDC_CONTRACT_ID =
  process.env.NEXT_PUBLIC_USDC_CONTRACT_ID ??
  'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

/**
 * Default period_ledgers for the spending_limit policy (~8 min at 5 s/ledger).
 * Matches the proven spike (14-deploy-policy.js PERIOD_LEDGERS = 100).
 */
const DEFAULT_PERIOD_LEDGERS = 100;

// ── ScVal encoders (ported from lib.js — proven on-chain) ────────────────────

/**
 * Signer::Delegated(Address) → scvVec([scvSymbol("Delegated"), Address.toScVal()])
 * Used in constructorArgs (owner signer on Default rule) and in vecSigners for
 * add_context_rule (session signer on the context rule).
 */
export function signerDelegated(addrStr: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Delegated'),
    new Address(addrStr).toScVal(),
  ]);
}

/**
 * ContextRuleType::CallContract(Address) → scvVec([scvSymbol("CallContract"), Address.toScVal()])
 * Permits the session key to call any function on the named contract (USDC SAC).
 * CallContract(USDC) is the tightest rule that permits arbitrary-payTo USDC payments.
 */
export function ctxCallContract(addrStr: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('CallContract'),
    new Address(addrStr).toScVal(),
  ]);
}

/**
 * Option<u32>: None → scvVoid(), Some(v) → nativeToScVal(v >>> 0, {type:"u32"})
 * Used for valid_until in add_context_rule.
 */
export function optU32(v: number | null | undefined): xdr.ScVal {
  return v == null
    ? xdr.ScVal.scvVoid()
    : nativeToScVal(v >>> 0, { type: 'u32' });
}

/**
 * Vec<Signer> → scvVec(arr)
 */
export function vecSigners(arr: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(arr);
}

/**
 * SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }
 * serialized as ScMap with keys sorted ascending by XDR (Soroban canonical order).
 *
 * Proven shape: 14-deploy-policy.js::spendingLimitParams + standard-transfer-findings.md §policy.
 *
 * @param limit   - spending limit in USDC atomic units (i128 bigint)
 * @param period  - period_ledgers (u32)
 */
export function spendingLimitParams(limit: bigint, period: number): xdr.ScVal {
  const entries = [
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('period_ledgers'),
      val: nativeToScVal(period >>> 0, { type: 'u32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('spending_limit'),
      val: nativeToScVal(limit.toString(), { type: 'i128' }),
    }),
  ];
  // Soroban requires sorted ScMap keys (by XDR hex, ascending).
  entries.sort((a, b) => a.key().toXDR('hex').localeCompare(b.key().toXDR('hex')));
  return xdr.ScVal.scvMap(entries);
}

// ── Auth helpers (ported from authlib.js — proven on-chain) ──────────────────

/**
 * Signatures(Map<Signer,Bytes>) ScVal — single-field tuple struct → scvVec[scvMap].
 * For Delegated signers the Bytes value is unused (OZ verifies via require_auth_for_args).
 *
 * Matches authlib.js::signaturesScVal exactly (proven on-chain).
 */
export function signaturesScVal(delegatedSignerAddresses: string[]): xdr.ScVal {
  const entries = delegatedSignerAddresses.map(
    (addr) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol('Delegated'),
          xdr.ScVal.scvAddress(Address.fromString(addr).toScAddress()),
        ]),
        val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
      }),
  );
  entries.sort((a, b) => a.key().toXDR('hex').localeCompare(b.key().toXDR('hex')));
  return xdr.ScVal.scvVec([xdr.ScVal.scvMap(entries)]);
}

/**
 * ed25519 signature ScVal for a G-address signer.
 * scvVec([ scvMap([ {public_key: bytes32}, {signature: bytes64} ]) ])
 *
 * Matches authlib.js::ed25519SignatureScVal exactly (proven on-chain).
 */
export function ed25519SignatureScVal(
  gAddress: string,
  signatureBuf: Uint8Array,
): xdr.ScVal {
  const pubKeyBytes = Address.fromString(gAddress).toScAddress().accountId().ed25519();
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('public_key'),
        val: xdr.ScVal.scvBytes(pubKeyBytes),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signature'),
        val: xdr.ScVal.scvBytes(Buffer.from(signatureBuf)),
      }),
    ]),
  ]);
}

// ── Freighter helpers ─────────────────────────────────────────────────────────

/**
 * Call Freighter's signAuthEntry with a constructed SorobanAuthorizationEntry.
 *
 * The signed entry XDR returned by Freighter replaces the input entry — Freighter
 * fills in the nonce, expiry, preimage, and signature.
 *
 * [BV-1] BROWSER-VALIDATION REQUIRED:
 *   Freighter v6 signAuthEntry(entryXdr, opts) typed return:
 *     { signedAuthEntry: string | null, signerAddress, error? }
 *   Older documentation says it returns a raw Buffer (signature bytes only).
 *   Both shapes are handled defensively below. The actual shape MUST be verified
 *   in a real browser with Freighter installed (Plan 3 T5 E2E).
 *
 * @param entry             - The SorobanAuthorizationEntry to sign.
 * @param networkPassphrase - Stellar network passphrase (passed to Freighter).
 * @returns The signed SorobanAuthorizationEntry from Freighter.
 */
async function signEntryWithFreighter(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
  ownerAddress: string,
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  // [BV-1] Freighter is browser-only — dynamic import avoids SSR errors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freighter = await import('@stellar/freighter-api' as any);

  // Canonical signing path: the SDK's authorizeEntry() builds the
  // HashIdPreimageSorobanAuthorization from this entry (its nonce + rootInvocation
  // + validUntil + networkId), hands it to our SigningCallback, then assembles the
  // signed entry in the correct account-signature format. Freighter's signAuthEntry
  // takes the PREIMAGE xdr and returns the signature (base64 in `signedAuthEntry`),
  // NOT the full entry — so we feed it the preimage and return {signature, publicKey}.
  return authorizeEntry(
    entry,
    async (preimage: xdr.HashIdPreimage) => {
      const res = await freighter.signAuthEntry(preimage.toXDR('base64'), {
        address: ownerAddress,
        networkPassphrase,
      });
      // Surface Freighter's REAL error (the previous code hid it behind a generic message).
      if (res?.error) {
        const e = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
        throw new Error(`[BV-1] Freighter signAuthEntry error: ${e}`);
      }
      if (!res?.signedAuthEntry) {
        throw new Error('[BV-1] Freighter signAuthEntry returned no signature (user rejected?).');
      }
      return {
        signature: Buffer.from(res.signedAuthEntry, 'base64'),
        publicKey: ownerAddress,
      };
    },
    validUntilLedger,
    networkPassphrase,
  );
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

function getRpcServer(): StellarRpc.Server {
  return new StellarRpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
}

/**
 * Poll getTransaction until it settles (not NOT_FOUND) or the timeout expires.
 * stellar-sdk ^15 GetTransactionStatus: SUCCESS | NOT_FOUND | FAILED.
 * NOT_FOUND = tx not yet visible (still being processed); keep polling.
 */
async function pollTransaction(
  server: StellarRpc.Server,
  txHash: string,
  timeoutMs = 90_000,
): Promise<StellarRpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + timeoutMs;
  let got = await server.getTransaction(txHash);
  while (
    got.status === StellarRpc.Api.GetTransactionStatus.NOT_FOUND &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2_000));
    got = await server.getTransaction(txHash);
  }
  return got;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect the user's Freighter wallet and return the owner G-address.
 *
 * Calls requestAccess() which prompts the user if not already connected.
 * Handles the { address, error? } return shape from Freighter v6.
 *
 * [BV-2] Browser-only — requires Freighter installed.
 */
export async function connectWallet(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freighter = await import('@stellar/freighter-api' as any);
  const result = await freighter.requestAccess();
  if (result?.error) throw new Error(`Freighter error: ${result.error}`);
  // v6 shape: { address: string, error?: string }
  const address = typeof result === 'string' ? result : result?.address;
  if (!address || typeof address !== 'string') {
    throw new Error('Freighter did not return a valid address');
  }
  return address;
}

// ── createOrConnectAccount ────────────────────────────────────────────────────

export interface CreateOrConnectOpts {
  /** Owner G-address (from connectWallet). */
  ownerAddress: string;
  /** Optional 32-byte hex salt. If omitted, a random 32-byte salt is generated. */
  salt?: string;
}

export interface CreateOrConnectResult {
  smartAccount: string;
  /** true if a new account was deployed; false if an existing binding was found. */
  deployed: boolean;
}

/**
 * Existing-wallet path: deploy an OZ smart account whose Default-rule signer
 * is Delegated(ownerAddress).
 *
 * Constructor args (spike 02-deploy-account.js, proven on-chain):
 *   createCustomContract({
 *     address: Address(ownerAddress),   ← deploy authority
 *     wasmHash: hexToBytes(OZ_ACCOUNT_WASM_HASH),
 *     salt: random32,
 *     constructorArgs: [
 *       vecSigners([signerDelegated(ownerAddress)]),  // Vec<Signer>
 *       scvMap([]),                                   // Map<Address, Val> policies
 *     ],
 *   })
 *
 * The owner is the tx source (pays gas). Signed via Freighter signTransaction.
 * The new contract id is read from getTransaction.returnValue via Address.fromScVal.
 *
 * [BV-2] BROWSER-VALIDATION REQUIRED:
 *   The full simulate → signTransaction → submit → poll flow requires a real
 *   Freighter connection and Stellar testnet RPC (Plan 3 T5).
 *   The owner must have XLM (testnet: show friendbot link https://friendbot.stellar.org/?addr=<G>).
 */
export async function createOrConnectAccount(
  opts: CreateOrConnectOpts,
): Promise<CreateOrConnectResult> {
  const { ownerAddress } = opts;

  // [BV-2] Browser-only: Freighter + RPC.
  const server = getRpcServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freighter = await import('@stellar/freighter-api' as any);

  const wasmHashBuf = Buffer.from(OZ_ACCOUNT_WASM_HASH, 'hex');

  const salt = opts.salt
    ? Buffer.from(opts.salt, 'hex')
    : (() => {
        const b = new Uint8Array(32);
        if (
          typeof globalThis !== 'undefined' &&
          globalThis.crypto &&
          typeof globalThis.crypto.getRandomValues === 'function'
        ) {
          globalThis.crypto.getRandomValues(b);
        } else {
          // Node.js fallback (e.g. test environment).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const nc = require('crypto') as typeof import('crypto');
          nc.randomFillSync(b);
        }
        return Buffer.from(b);
      })();

  const ctorArgs: xdr.ScVal[] = [
    vecSigners([signerDelegated(ownerAddress)]), // Vec<Signer>: owner as Delegated
    xdr.ScVal.scvMap([]), // Map<Address, Val> policies: empty
  ];

  const sourceAccount = await server.getAccount(ownerAddress);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '5000000',
    networkPassphrase: STELLAR_NETWORK,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(ownerAddress),
        wasmHash: wasmHashBuf,
        salt,
        constructorArgs: ctorArgs,
      }),
    )
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(sim)) {
    throw new Error(`Deploy simulation failed: ${sim.error}`);
  }
  const assembled = StellarRpc.assembleTransaction(tx, sim).build();

  // [BV-2] Sign via Freighter — owner pays gas and authorises the deploy.
  const signResult = await freighter.signTransaction(assembled.toXDR(), {
    networkPassphrase: STELLAR_NETWORK,
    address: ownerAddress,
  });
  if (signResult?.error) throw new Error(`Freighter signTransaction error: ${signResult.error}`);
  // v6 shape: { signedTxXdr: string, signerAddress, error? }
  const signedXdr: string = signResult?.signedTxXdr ?? signResult;
  const signed = new Transaction(signedXdr, STELLAR_NETWORK);

  const send = await server.sendTransaction(signed);
  if (send.status === 'ERROR') {
    throw new Error(`Deploy send failed: ${JSON.stringify(send)}`);
  }

  const got = await pollTransaction(server, send.hash);
  if (got.status !== StellarRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Deploy tx ${got.status}: ${send.hash}`);
  }

  if (!('returnValue' in got) || !got.returnValue) {
    throw new Error('Deploy tx succeeded but returnValue is missing');
  }
  const smartAccount = Address.fromScVal(got.returnValue).toString();
  return { smartAccount, deployed: true };
}

/**
 * Passkey path — NOT IMPLEMENTED in v1.
 *
 * [BV-3] Scaffold only. Full implementation requires:
 *   - WebAuthn / secp256r1 credential creation
 *   - External signer type on the OZ account
 *   - webauthn-verifier contract deployment
 *   - passkey-kit or smart-account-kit integration
 *
 * Deferred — use connectWallet() + createOrConnectAccount() for v1.
 */
export async function createWithPasskey(_opts?: unknown): Promise<CreateOrConnectResult> {
  throw new Error(
    'not_implemented: Passkey wallet onboarding is coming soon. ' +
      'Use connectWallet() + createOrConnectAccount() for v1.',
  );
}

// ── delegate ──────────────────────────────────────────────────────────────────

export interface DelegateOpts {
  /** The OZ smart account C-address. */
  smartAccount: string;
  /** Session ed25519 G-address (from POST /wallet/session-signer). */
  sessionPubkey: string;
  /** Budget in USDC atomic units (i128). Use toAtomicUsdc() from delegation.ts. */
  budgetAtomic: bigint;
  /** Expiry ledger. Use expiryToLedger() from delegation.ts + current ledger from RPC. */
  validUntilLedger: number;
  /** Owner G-address (from connectWallet). */
  ownerAddress: string;
  /**
   * Period for spending_limit policy (ledgers). Defaults to DEFAULT_PERIOD_LEDGERS (100 ≈ 8 min).
   * The policy resets the spent amount after each period.
   */
  periodLedgers?: number;
}

export interface DelegateResult {
  /** TX hash of add_context_rule (signer). */
  ruleTxHash: string;
  /** TX hash of add_policy (installs the spending-limit params). */
  policyTxHash: string;
  /**
   * The rule id of the verivyx-session rule. delegate() throws before add_policy if
   * this cannot be resolved, so on a successful return it is always a valid rule id.
   */
  ruleId: number;
}

/**
 * Delegate a budget-capped, expiry-limited context rule to the MCP session signer.
 *
 * Two-step sequence (proven on-chain: spike 11 + spike 14):
 *
 *   Step 1 — add_context_rule:
 *     contract: smartAccount
 *     fn: add_context_rule(
 *       CallContract(USDC),              // ContextRuleType: permit USDC.transfer to any `to`
 *       "verivyx-session",               // name (string)
 *       valid_until,                     // Option<u32> ledger expiry
 *       [Delegated(sessionPubkey)],      // Vec<Signer>
 *       {},                              // empty policies (Map<Address,Val>) — added below
 *     )
 *
 *   Step 2 — add_policy:
 *     contract: smartAccount
 *     fn: add_policy(
 *       ruleId,                          // u32
 *       SPENDING_LIMIT_POLICY_ADDRESS,   // Address
 *       spendingLimitParams(budget, period),  // SpendingLimitAccountParams ScMap
 *     )
 *
 * Owner auth tree (authlib.js::signDelegated, proven on-chain):
 *   - Outer entry: SA credential { Signatures: { Delegated(owner): empty } }
 *   - Inner entry: owner G-address credential, signed by Freighter via signAuthEntry()
 *
 * [BV-1] Freighter signAuthEntry shape: see signEntryWithFreighter().
 * [BV-2] Full RPC + submission: requires browser environment (Plan 3 T5).
 */
export async function delegate(opts: DelegateOpts): Promise<DelegateResult> {
  const {
    smartAccount,
    sessionPubkey,
    budgetAtomic,
    validUntilLedger,
    ownerAddress,
    periodLedgers = DEFAULT_PERIOD_LEDGERS,
  } = opts;

  const server = getRpcServer();

  // ── Step 1: add_context_rule (signer only, EMPTY policies) ───────────────────
  // The spending-limit policy is installed in Step 2 via add_policy. Installing the
  // policy through add_context_rule's policies map only ATTACHES it without storing
  // the per-account params → __check_auth later fails with Storage(MissingValue)
  // ("non-existing value for account"). add_policy is what actually installs them.

  const opRule = Operation.invokeContractFunction({
    contract: smartAccount,
    function: 'add_context_rule',
    args: [
      ctxCallContract(USDC_CONTRACT_ID),
      nativeToScVal('verivyx-session', { type: 'string' }),
      optU32(validUntilLedger),
      vecSigners([signerDelegated(sessionPubkey)]),
      xdr.ScVal.scvMap([]), // empty policies — installed separately via add_policy
    ],
  });

  const ruleTxHash = await submitWithOwnerAuth({
    server,
    networkPassphrase: STELLAR_NETWORK,
    sourceAddress: ownerAddress,
    smartAccount,
    ownerAddress,
    op: opRule,
    label: 'add_context_rule',
  });

  // Query get_context_rules to extract the ruleId for the verivyx-session rule.
  let ruleId: number | null = null;
  try {
    const opGet = Operation.invokeContractFunction({
      contract: smartAccount,
      function: 'get_context_rules',
      args: [ctxCallContract(USDC_CONTRACT_ID)],
    });
    const sourceAccount = await server.getAccount(ownerAddress);
    const getTx = new TransactionBuilder(sourceAccount, {
      fee: '1000000',
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(opGet)
      .setTimeout(60)
      .build();
    const getSim = await server.simulateTransaction(getTx);
    if (!StellarRpc.Api.isSimulationError(getSim) && getSim.result?.retval) {
      const rules = scValToNative(getSim.result.retval) as Array<{
        id?: number;
        name?: string;
      }>;
      if (Array.isArray(rules) && rules.length > 0) {
        const sessionRule = rules.find((r) => r.name === 'verivyx-session');
        ruleId = (sessionRule?.id ?? rules[rules.length - 1]?.id) ?? null;
      }
    }
  } catch {
    // Non-fatal here, but Step 2 requires ruleId — guarded below.
  }

  // ── Step 2: add_policy (installs the spending-limit params for this account) ──
  if (ruleId == null) {
    throw new Error(
      'delegate: could not resolve the new context-rule id; aborting before add_policy to avoid an installed rule without a spending limit',
    );
  }

  const opPolicy = Operation.invokeContractFunction({
    contract: smartAccount,
    function: 'add_policy',
    args: [
      nativeToScVal(ruleId >>> 0, { type: 'u32' }), // rule_id u32
      new Address(SPENDING_LIMIT_POLICY_ADDRESS).toScVal(), // policy contract
      spendingLimitParams(budgetAtomic, periodLedgers), // SpendingLimitAccountParams
    ],
  });

  const policyTxHash = await submitWithOwnerAuth({
    server,
    networkPassphrase: STELLAR_NETWORK,
    sourceAddress: ownerAddress,
    smartAccount,
    ownerAddress,
    op: opPolicy,
    label: 'add_policy',
  });

  return { ruleTxHash, policyTxHash, ruleId };
}

// ── revoke ────────────────────────────────────────────────────────────────────

export interface RevokeOpts {
  /** The OZ smart account C-address. */
  smartAccount: string;
  /** The context rule id to remove (from DelegateResult.ruleId). */
  ruleId: number;
  /** Owner G-address (from connectWallet). */
  ownerAddress: string;
}

export interface RevokeResult {
  txHash: string;
}

/**
 * Revoke the session delegation by removing the context rule.
 *
 * Calls remove_context_rule(ruleId) on the smart account, owner-signed via the
 * same two-entry auth tree as delegate().
 *
 * After this call the session key can no longer authorize USDC.transfer from
 * the smart account. Call walletApi.revokeBinding() to inform the MCP server.
 *
 * [BV-2] Requires a real browser + Freighter for end-to-end verification.
 */
export async function revoke(opts: RevokeOpts): Promise<RevokeResult> {
  const { smartAccount, ruleId, ownerAddress } = opts;
  const server = getRpcServer();

  const opRevoke = Operation.invokeContractFunction({
    contract: smartAccount,
    function: 'remove_context_rule',
    args: [nativeToScVal(ruleId >>> 0, { type: 'u32' })],
  });

  const txHash = await submitWithOwnerAuth({
    server,
    networkPassphrase: STELLAR_NETWORK,
    sourceAddress: ownerAddress,
    smartAccount,
    ownerAddress,
    op: opRevoke,
    label: 'remove_context_rule',
  });

  return { txHash };
}

// ── submitWithOwnerAuth (internal) ────────────────────────────────────────────

interface OwnerAuthOpts {
  server: StellarRpc.Server;
  networkPassphrase: string;
  sourceAddress: string;
  smartAccount: string;
  ownerAddress: string;
  op: xdr.Operation;
  label: string;
}

/**
 * Build, simulate, apply the two-entry owner-auth tree (Freighter), and submit
 * a smart-account invocation.
 *
 * Auth tree (authlib.js::signDelegated, proven on-chain):
 *
 *   Outer entry (SA credential):
 *     - signatureExpirationLedger = current + 200
 *     - signature = signaturesScVal([ownerAddress])  ← Delegated marker, no ed25519
 *
 *   Inner entry (owner G-address credential):
 *     - rootInvocation = __check_auth(saSignaturePayloadHash) on the SA
 *     - credentials.address = ownerAddress
 *     - signed via Freighter's signAuthEntry (owner signs the constructed entry)
 *
 * The outer tx envelope is also signed by Freighter (owner pays gas).
 *
 * Note on authorizeEntry() vs manual:
 *   The stellar-base authorizeEntry() expects a SigningCallback(preimage) → signature.
 *   Freighter's signAuthEntry() takes an entry XDR, not a raw preimage.
 *   To avoid the type mismatch and the shape ambiguity, we construct the inner
 *   entry manually (following authlib.js) and call Freighter's signAuthEntry on it.
 *   The SDK's authorizeEntry is NOT used here — see signEntryWithFreighter().
 *
 * [BV-1] Freighter signAuthEntry shape: see signEntryWithFreighter().
 * [BV-2] Full RPC + signTransaction: browser-only.
 */
async function submitWithOwnerAuth(opts: OwnerAuthOpts): Promise<string> {
  const { server, networkPassphrase, sourceAddress, smartAccount, ownerAddress, op, label } = opts;
  const networkId = hash(Buffer.from(networkPassphrase));

  // 1) Simulate to get auth entries + current ledger.
  const latest = await server.getLatestLedger();
  const expirationLedger = latest.sequence + 200; // ~17 min safety window

  const sourceAccount = await server.getAccount(sourceAddress);
  const tx1 = new TransactionBuilder(sourceAccount, {
    fee: '10000000',
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim1 = await server.simulateTransaction(tx1);
  if (StellarRpc.Api.isSimulationError(sim1)) {
    throw new Error(`[${label}] Simulation failed: ${sim1.error}`);
  }

  const rawAuths: xdr.SorobanAuthorizationEntry[] = (sim1.result?.auth ?? []).map(
    (a): xdr.SorobanAuthorizationEntry =>
      typeof a === 'string'
        ? xdr.SorobanAuthorizationEntry.fromXDR(a, 'base64')
        : (a as xdr.SorobanAuthorizationEntry),
  );

  // 2) Build the two-entry auth tree for each SA auth entry.
  const signedAuths: xdr.SorobanAuthorizationEntry[] = [];

  for (const entry0 of rawAuths) {
    // Clone to avoid mutating the simulated entry.
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entry0.toXDR());

    const cred = entry.credentials();
    if (cred.switch().name !== 'sorobanCredentialsAddress') {
      signedAuths.push(entry);
      continue;
    }

    const authAddress = Address.fromScAddress(cred.address().address()).toString();
    if (authAddress !== smartAccount) {
      // Not our SA — pass through (handled by other signers if any).
      signedAuths.push(entry);
      continue;
    }

    // ── Outer SA entry: Delegated marker (no ed25519 sig needed) ──────────
    // (authlib.js lines 65-68: set exp + attach Signatures map)
    entry.credentials().address().signatureExpirationLedger(expirationLedger);
    entry.credentials().address().signature(signaturesScVal([ownerAddress]));
    signedAuths.push(entry);

    // ── Inner owner entry: signed by Freighter via signAuthEntry() ─────────
    //
    // Compute the SA's own signature payload hash.
    // (authlib.js lines 71-79: hash of the SA credential preimage)
    const saPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: entry.credentials().address().nonce(),
        signatureExpirationLedger: expirationLedger,
        invocation: entry.rootInvocation(),
      }),
    );
    const signaturePayload = hash(saPreimage.toXDR());

    // Build the __check_auth delegated invocation.
    // (authlib.js lines 82-98: delegatedNonce + delegatedInvocation)
    const delegatedNonce = xdr.Int64.fromString(
      // Unique-ish nonce per authlib.js line 83.
      (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString(),
    );
    const delegatedInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(smartAccount).toScAddress(),
          functionName: '__check_auth',
          args: [xdr.ScVal.scvBytes(signaturePayload)],
        }),
      ),
      subInvocations: [],
    });

    // Build the pre-entry for the owner G-address (unsigned placeholder).
    // Freighter's signAuthEntry will fill in the signature.
    // [BV-1] We construct the entry with a void placeholder signature.
    // Freighter receives the entry XDR, computes the preimage internally,
    // and returns the signed entry XDR (v6 shape).
    const ownerPreEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(ownerAddress).toScAddress(),
          nonce: delegatedNonce,
          signatureExpirationLedger: expirationLedger,
          signature: xdr.ScVal.scvVoid(), // placeholder — Freighter fills this
        }),
      ),
      rootInvocation: delegatedInvocation,
    });

    // [BV-1] Sign the owner entry via Freighter (authorizeEntry builds the preimage,
    // Freighter signs it, the SDK assembles the signed account-credential entry).
    const signedOwnerEntry = await signEntryWithFreighter(
      ownerPreEntry,
      networkPassphrase,
      ownerAddress,
      expirationLedger,
    );
    signedAuths.push(signedOwnerEntry);
  }

  // 3) Re-build tx with signed auth, re-simulate, assemble, sign outer tx, submit.
  const sourceAccount2 = await server.getAccount(sourceAddress);
  const tx2 = new TransactionBuilder(sourceAccount2, {
    fee: '10000000',
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  // Inject signed auth entries (spike pattern: manipulate the XDR envelope).
  const env2 = tx2.toEnvelope();
  env2.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(signedAuths);
  const tx2WithAuth = new Transaction(env2, networkPassphrase);

  const sim2 = await server.simulateTransaction(tx2WithAuth);
  if (StellarRpc.Api.isSimulationError(sim2)) {
    throw new Error(`[${label}] Re-simulation failed: ${sim2.error}`);
  }

  let prepared = StellarRpc.assembleTransaction(tx2WithAuth, sim2).build();

  // If assembleTransaction dropped auth, re-inject (spike pattern from 11 + 14).
  const prepEnv = prepared.toEnvelope();
  const prepOp = prepEnv.v1().tx().operations()[0].body().invokeHostFunctionOp();
  if (prepOp.auth().length === 0) {
    prepOp.auth(signedAuths);
    prepared = new Transaction(prepEnv, networkPassphrase);
  }

  // [BV-2] Sign the outer tx envelope with Freighter (owner pays gas).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freighter = await import('@stellar/freighter-api' as any);
  const signResult = await freighter.signTransaction(prepared.toXDR(), {
    networkPassphrase,
    address: sourceAddress,
  });
  if (signResult?.error)
    throw new Error(`[${label}] Freighter signTransaction error: ${signResult.error}`);
  const signedXdr: string = signResult?.signedTxXdr ?? signResult;
  const signedTx = new Transaction(signedXdr, networkPassphrase);

  const send = await server.sendTransaction(signedTx);
  if (send.status === 'ERROR') {
    throw new Error(`[${label}] Send failed: ${JSON.stringify(send)}`);
  }

  const got = await pollTransaction(server, send.hash);
  if (got.status !== StellarRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`[${label}] TX ${got.status}: ${send.hash}`);
  }

  return send.hash;
}
