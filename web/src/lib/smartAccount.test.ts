/**
 * Pure-logic tests for smartAccount.ts ScVal encoders.
 *
 * OFFLINE ONLY — no browser, no Freighter, no Stellar RPC.
 * Tests cover the on-chain-proven ScVal shapes ported from the spike scripts.
 *
 * Run: docker run --rm -v "$PWD/web":/app -w /app node:20-alpine \
 *        sh -c "npm ci && npm test"
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import {
  signerDelegated,
  ctxCallContract,
  optU32,
  vecSigners,
  spendingLimitParams,
  signaturesScVal,
  ed25519SignatureScVal,
} from './smartAccount.js';

// ── constants ─────────────────────────────────────────────────────────────────

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
// Real testnet G-addresses from the on-chain spike (standard-transfer-findings.md).
const SESSION_PUB = 'GAVPYJLHXV6LANM5OREB65X22MXZO5PLBONIPXJGYF4QPJUGQUVDG4NG';
const OWNER_PUB = 'GBJFBJYNVBKAH7X2ZC6WWVSVUUVZZMLOWE4F7OL22W6ENJABI7I2H2ML';

// ── signerDelegated ───────────────────────────────────────────────────────────

describe('signerDelegated', () => {
  it('produces scvVec with two elements', () => {
    const val = signerDelegated(SESSION_PUB);
    assert.equal(val.switch().name, 'scvVec');
    const vec = val.vec();
    assert.ok(vec !== null && vec !== undefined);
    assert.equal(vec!.length, 2);
  });

  it('first element is scvSymbol("Delegated")', () => {
    const val = signerDelegated(SESSION_PUB);
    const vec = val.vec()!;
    assert.equal(vec[0].switch().name, 'scvSymbol');
    assert.equal(vec[0].sym(), 'Delegated');
  });

  it('second element is scvAddress matching the input', () => {
    const val = signerDelegated(SESSION_PUB);
    const vec = val.vec()!;
    assert.equal(vec[1].switch().name, 'scvAddress');
    const addr = Address.fromScVal(vec[1]).toString();
    assert.equal(addr, SESSION_PUB);
  });

  it('round-trips through XDR', () => {
    const val = signerDelegated(OWNER_PUB);
    const xdrHex = val.toXDR('hex');
    const restored = xdr.ScVal.fromXDR(xdrHex, 'hex');
    assert.equal(restored.switch().name, 'scvVec');
    // .sym() may return a Buffer (raw bytes) or string depending on SDK version.
    const sym = restored.vec()![0].sym();
    const symStr = Buffer.isBuffer(sym) ? sym.toString('utf8') : String(sym);
    assert.equal(symStr, 'Delegated');
  });
});

// ── ctxCallContract ───────────────────────────────────────────────────────────

describe('ctxCallContract', () => {
  it('produces scvVec with two elements', () => {
    const val = ctxCallContract(USDC_TESTNET);
    assert.equal(val.switch().name, 'scvVec');
    assert.equal(val.vec()!.length, 2);
  });

  it('first element is scvSymbol("CallContract")', () => {
    const vec = ctxCallContract(USDC_TESTNET).vec()!;
    assert.equal(vec[0].switch().name, 'scvSymbol');
    assert.equal(vec[0].sym(), 'CallContract');
  });

  it('second element is scvAddress matching the USDC contract', () => {
    const vec = ctxCallContract(USDC_TESTNET).vec()!;
    assert.equal(vec[1].switch().name, 'scvAddress');
    const addr = Address.fromScVal(vec[1]).toString();
    assert.equal(addr, USDC_TESTNET);
  });

  it('different from signerDelegated (different symbol)', () => {
    const ctx = ctxCallContract(USDC_TESTNET);
    const sig = signerDelegated(USDC_TESTNET);
    assert.notEqual(ctx.toXDR('hex'), sig.toXDR('hex'));
  });
});

// ── optU32 ────────────────────────────────────────────────────────────────────

describe('optU32', () => {
  it('null → scvVoid', () => {
    const val = optU32(null);
    assert.equal(val.switch().name, 'scvVoid');
  });

  it('undefined → scvVoid', () => {
    const val = optU32(undefined);
    assert.equal(val.switch().name, 'scvVoid');
  });

  it('0 → scvU32(0)', () => {
    const val = optU32(0);
    assert.equal(val.switch().name, 'scvU32');
    assert.equal(val.u32(), 0);
  });

  it('500 → scvU32(500)', () => {
    const val = optU32(500);
    assert.equal(val.switch().name, 'scvU32');
    assert.equal(val.u32(), 500);
  });

  it('1_000_000 → scvU32(1_000_000)', () => {
    const val = optU32(1_000_000);
    assert.equal(val.switch().name, 'scvU32');
    assert.equal(val.u32(), 1_000_000);
  });
});

// ── vecSigners ────────────────────────────────────────────────────────────────

describe('vecSigners', () => {
  it('wraps elements in a scvVec', () => {
    const s1 = signerDelegated(SESSION_PUB);
    const s2 = signerDelegated(OWNER_PUB);
    const vec = vecSigners([s1, s2]);
    assert.equal(vec.switch().name, 'scvVec');
    assert.equal(vec.vec()!.length, 2);
  });

  it('single element round-trips', () => {
    const s = signerDelegated(SESSION_PUB);
    const vec = vecSigners([s]);
    assert.equal(vec.vec()!.length, 1);
    assert.equal(vec.vec()![0].vec()![0].sym(), 'Delegated');
  });
});

// ── spendingLimitParams ───────────────────────────────────────────────────────

describe('spendingLimitParams', () => {
  it('returns scvMap', () => {
    const val = spendingLimitParams(1_000_000n, 100);
    assert.equal(val.switch().name, 'scvMap');
  });

  it('has exactly two entries', () => {
    const val = spendingLimitParams(1_000_000n, 100);
    assert.equal(val.map()!.length, 2);
  });

  it('keys are sorted: period_ledgers before spending_limit', () => {
    const val = spendingLimitParams(1_000_000n, 100);
    const entries = val.map()!;
    assert.equal(entries[0].key().sym(), 'period_ledgers');
    assert.equal(entries[1].key().sym(), 'spending_limit');
  });

  it('period_ledgers is scvU32(100)', () => {
    const val = spendingLimitParams(1_000_000n, 100);
    const entries = val.map()!;
    assert.equal(entries[0].val().switch().name, 'scvU32');
    assert.equal(entries[0].val().u32(), 100);
  });

  it('spending_limit is scvI128 matching 1_000_000', () => {
    const val = spendingLimitParams(1_000_000n, 100);
    const entries = val.map()!;
    assert.equal(entries[1].val().switch().name, 'scvI128');
    // scValToNative on i128 returns bigint
    const native = scValToNative(entries[1].val());
    assert.equal(native, 1_000_000n);
  });

  it('spendingLimitParams(1_000_000n, 100) sort order matches spike 14 contract', () => {
    // Verify: period_ledgers XDR < spending_limit XDR (sorted ascending).
    const val = spendingLimitParams(1_000_000n, 100);
    const entries = val.map()!;
    const k0 = entries[0].key().toXDR('hex');
    const k1 = entries[1].key().toXDR('hex');
    assert.ok(k0 < k1, `Expected period_ledgers (${k0}) < spending_limit (${k1})`);
  });

  it('large budget (150_000_000n) stores correctly as i128', () => {
    const val = spendingLimitParams(150_000_000n, 200);
    const entries = val.map()!;
    const native = scValToNative(entries[1].val());
    assert.equal(native, 150_000_000n);
  });

  it('different period produces different XDR', () => {
    const v1 = spendingLimitParams(1_000_000n, 100);
    const v2 = spendingLimitParams(1_000_000n, 200);
    assert.notEqual(v1.toXDR('hex'), v2.toXDR('hex'));
  });
});

// ── signaturesScVal ───────────────────────────────────────────────────────────

describe('signaturesScVal', () => {
  it('returns scvVec wrapping a scvMap', () => {
    const val = signaturesScVal([OWNER_PUB]);
    assert.equal(val.switch().name, 'scvVec');
    const outer = val.vec()!;
    assert.equal(outer.length, 1);
    assert.equal(outer[0].switch().name, 'scvMap');
  });

  it('single address: one map entry with scvBytes value (empty)', () => {
    const val = signaturesScVal([OWNER_PUB]);
    const mapEntries = val.vec()![0].map()!;
    assert.equal(mapEntries.length, 1);
    // The key is scvVec([scvSymbol("Delegated"), scvAddress(...)]).
    assert.equal(mapEntries[0].key().switch().name, 'scvVec');
    assert.equal(mapEntries[0].key().vec()![0].sym(), 'Delegated');
    // The value is empty bytes.
    assert.equal(mapEntries[0].val().switch().name, 'scvBytes');
    assert.equal(mapEntries[0].val().bytes().length, 0);
  });

  it('multiple addresses produce sorted entries', () => {
    const val = signaturesScVal([OWNER_PUB, SESSION_PUB]);
    const mapEntries = val.vec()![0].map()!;
    assert.equal(mapEntries.length, 2);
    // Verify sort: k0 <= k1 by XDR hex.
    const k0 = mapEntries[0].key().toXDR('hex');
    const k1 = mapEntries[1].key().toXDR('hex');
    assert.ok(k0 <= k1, `Expected sorted keys: ${k0} <= ${k1}`);
  });
});

// ── ed25519SignatureScVal ─────────────────────────────────────────────────────

describe('ed25519SignatureScVal', () => {
  const fakeSig = Buffer.alloc(64, 0xab);

  it('returns scvVec wrapping a scvMap with 2 entries', () => {
    const val = ed25519SignatureScVal(OWNER_PUB, fakeSig);
    assert.equal(val.switch().name, 'scvVec');
    const inner = val.vec()![0];
    assert.equal(inner.switch().name, 'scvMap');
    assert.equal(inner.map()!.length, 2);
  });

  it('first entry: public_key → scvBytes(32 bytes)', () => {
    const val = ed25519SignatureScVal(OWNER_PUB, fakeSig);
    const entries = val.vec()![0].map()!;
    assert.equal(entries[0].key().sym(), 'public_key');
    assert.equal(entries[0].val().switch().name, 'scvBytes');
    // ed25519 public key is 32 bytes.
    assert.equal(entries[0].val().bytes().length, 32);
  });

  it('second entry: signature → scvBytes(64 bytes matching input)', () => {
    const val = ed25519SignatureScVal(OWNER_PUB, fakeSig);
    const entries = val.vec()![0].map()!;
    assert.equal(entries[1].key().sym(), 'signature');
    assert.equal(entries[1].val().switch().name, 'scvBytes');
    assert.equal(entries[1].val().bytes().length, 64);
    assert.ok(entries[1].val().bytes().equals(fakeSig));
  });

  it('public_key bytes match the address ed25519 key', () => {
    const val = ed25519SignatureScVal(OWNER_PUB, fakeSig);
    const pkBytes = val.vec()![0].map()![0].val().bytes();
    const expected = Address.fromString(OWNER_PUB).toScAddress().accountId().ed25519();
    assert.ok(pkBytes.equals(expected));
  });

  it('different signer → different public_key bytes', () => {
    const v1 = ed25519SignatureScVal(OWNER_PUB, fakeSig);
    const v2 = ed25519SignatureScVal(SESSION_PUB, fakeSig);
    const pk1 = v1.vec()![0].map()![0].val().bytes();
    const pk2 = v2.vec()![0].map()![0].val().bytes();
    assert.ok(!pk1.equals(pk2));
  });
});

// ── integration: full delegate args shape ─────────────────────────────────────

describe('delegate args shape (offline construction)', () => {
  it('add_context_rule args are constructible without errors', () => {
    const args = [
      ctxCallContract(USDC_TESTNET),
      nativeToScVal('verivyx-session', { type: 'string' }),
      optU32(2_000_000),
      vecSigners([signerDelegated(SESSION_PUB)]),
      xdr.ScVal.scvMap([]),
    ];
    assert.equal(args.length, 5);
    // First arg: CallContract(USDC)
    assert.equal(args[0].vec()![0].sym(), 'CallContract');
    // Third arg: Option<u32>
    assert.equal(args[2].switch().name, 'scvU32');
    // Fourth arg: Vec<Signer>
    assert.equal(args[3].switch().name, 'scvVec');
    assert.equal(args[3].vec()![0].vec()![0].sym(), 'Delegated');
    // Fifth arg: empty Map
    assert.equal(args[4].switch().name, 'scvMap');
    assert.equal(args[4].map()!.length, 0);
  });

  it('add_policy args are constructible', () => {
    const POLICY = 'CBGLHQVGQEWBWW6JJXKLLMQZL3G4ENHFRBORLAUO2ZYVAJ2EZWYVMZC2';
    const ruleId = 0;
    const args = [
      nativeToScVal(ruleId >>> 0, { type: 'u32' }),
      new Address(POLICY).toScVal(),
      spendingLimitParams(1_500_000n, 100),
    ];
    assert.equal(args.length, 3);
    assert.equal(args[0].switch().name, 'scvU32');
    assert.equal(args[1].switch().name, 'scvAddress');
    assert.equal(args[2].switch().name, 'scvMap');
  });
});
