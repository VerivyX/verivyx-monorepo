import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateStellar,
  validateSlug,
  normalizeDomain,
  leadingZeroBits,
  fingerprintReason,
} from '../lib.js';

test('validateStellar accepts a valid G-address and rejects malformed input', () => {
  assert.equal(
    validateStellar('GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X'),
    'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X',
  );
  assert.equal(validateStellar('  GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X  '),
    'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X');
  // Secret keys (S...) must be rejected — only public keys belong here.
  assert.equal(validateStellar('SCSJBNGQ7UOMDKP4DPHIQOF62B6GX453MFMTGWPIVU5J24EKJV3EJZTE'), null);
  assert.equal(validateStellar('GSHORT'), null);
  assert.equal(validateStellar('gdcplkm7cktqzvkjy4uxbnflf6n3mt3enkptug4fugpiutoqlxzisc6x'), null); // lowercase
  assert.equal(validateStellar(''), null);
  assert.equal(validateStellar(null), null);
  assert.equal(validateStellar(42 as unknown as string), null);
});

test('validateSlug normalizes case and rejects edge cases', () => {
  assert.equal(validateSlug('Hello-World'), 'hello-world');
  assert.equal(validateSlug(''), null);
  assert.equal(validateSlug('-leading'), null);
  assert.equal(validateSlug('trailing-'), null);
  assert.equal(validateSlug('a'.repeat(64)), 'a'.repeat(64)); // 64 is the max allowed
  assert.equal(validateSlug('a'.repeat(65)), null); // 65 exceeds the limit
  assert.equal(validateSlug(undefined as unknown as string), null);
});

test('normalizeDomain handles ports/uppercase/trailing path consistently', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.Example.COM/a/b?c=d'), 'example.com');
  assert.equal(normalizeDomain('sub.domain.example.io'), 'sub.domain.example.io');
  assert.equal(normalizeDomain('localhost'), null); // single label rejected
});

test('leadingZeroBits counts across multiple zero bytes', () => {
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x00])), 24);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x40])), 9);
  assert.equal(leadingZeroBits(Buffer.from([])), 0);
});

test('fingerprintReason covers every bot branch', () => {
  const ok = {
    webdriver: false,
    languages: ['en'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    hardwareConcurrency: 8,
    screenWidth: 1920,
    screenHeight: 1080,
  };
  assert.equal(fingerprintReason(ok), null);
  assert.equal(fingerprintReason(null as unknown as Record<string, unknown>), 'fingerprint_missing');
  assert.equal(fingerprintReason({ ...ok, userAgent: 'short' }), 'bad_user_agent');
  assert.equal(fingerprintReason({ ...ok, userAgent: 'ClaudeBot/1.0 long-enough' }), 'bot_user_agent');
  assert.equal(fingerprintReason({ ...ok, hardwareConcurrency: 0 }), 'cpu_anomaly');
  assert.equal(fingerprintReason({ ...ok, hardwareConcurrency: 999 }), 'cpu_anomaly');
  assert.equal(fingerprintReason({ ...ok, screenWidth: 10 }), 'screen_anomaly');
  assert.equal(fingerprintReason({ ...ok, webglVendor: 'Google SwiftShader' }), 'software_gpu');
  assert.equal(fingerprintReason({ ...ok, webglRenderer: 'llvmpipe (LLVM 12)' }), 'vm_gpu');
});
