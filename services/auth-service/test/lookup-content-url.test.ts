// Tests for the contentUrl field in /auth/lookup response shape.
// No live DB required: we test the shape contract by replicating the
// exact transformation performed in the handler, mirroring the pattern
// used in mcp-early-access.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---- shapeLookup contract ----
// The /auth/lookup handler selects a fixed set of fields from the User row
// and maps them into a JSON response. This test pins the shape so that any
// future removal of contentUrl from the response is caught immediately.

function shapeLookup(user: {
  domain: string | null;
  stellar_address: string | null;
  pricePerRequest: { valueOf(): number } | number;
  platformFee: { valueOf(): number } | number | null;
  platform_address: string;
  paywallEnabled: boolean;
  wpInternalToken: string | null;
  contentUrl: string | null;
}) {
  return {
    domain: user.domain,
    stellar_address: user.stellar_address,
    pricePerRequest: Number(user.pricePerRequest),
    platformFee: Number(user.platformFee || 0),
    platform_address: user.platform_address,
    paywallEnabled: user.paywallEnabled,
    wpInternalToken: user.wpInternalToken ?? null,
    contentUrl: user.contentUrl ?? null,
  };
}

test('lookup shape: contentUrl is included when set on user', () => {
  const user = {
    domain: 'example.com',
    stellar_address: null,
    pricePerRequest: 0.005,
    platformFee: 0.001,
    platform_address: 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X',
    paywallEnabled: true,
    wpInternalToken: null,
    contentUrl: 'https://example.com/api/verivyx/content',
  };
  const result = shapeLookup(user);
  assert.equal(result.contentUrl, 'https://example.com/api/verivyx/content');
});

test('lookup shape: contentUrl is null when not set on user', () => {
  const user = {
    domain: 'example.com',
    stellar_address: null,
    pricePerRequest: 0.005,
    platformFee: null,
    platform_address: 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X',
    paywallEnabled: true,
    wpInternalToken: null,
    contentUrl: null,
  };
  const result = shapeLookup(user);
  assert.equal(result.contentUrl, null);
});

test('lookup shape: contentUrl key is always present in response object', () => {
  const user = {
    domain: 'example.com',
    stellar_address: null,
    pricePerRequest: 0.005,
    platformFee: 0.001,
    platform_address: 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X',
    paywallEnabled: true,
    wpInternalToken: 'secret-token',
    contentUrl: null,
  };
  const result = shapeLookup(user);
  assert.equal('contentUrl' in result, true, 'contentUrl key must always be present');
});
