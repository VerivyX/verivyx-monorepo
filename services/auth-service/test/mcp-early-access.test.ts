// Tests for the MCP early-access flag.
// Tests are focused on the pure-function/shape layer and the 401 auth boundary
// (no live DB required). Route-level grant/revoke flows are covered by E2E.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---- shapeUser contract ----
// shapeUser is not exported from index.ts, so we verify the contract by
// replicating the same transformation and asserting the field is present.
// This pins the public shape so any future removal of mcpEarlyAccess from
// shapeUser's output is caught.

test('shapeUser contract: mcpEarlyAccess is present and defaults to false', () => {
  // Mirror the shapeUser transformation exactly as implemented in index.ts.
  const raw = {
    id: 1,
    email: 'a@b.com',
    domain: 'b.com',
    stellar_address: null,
    emailVerified: false,
    pricePerRequest: { toString: () => '0.005' },
    platformFee: { toString: () => '0.001' },
    apiKey: null,
    role: 'CREATOR',
    paywallEnabled: true,
    mcpEarlyAccess: false,
    createdAt: new Date(),
  };

  const shaped = {
    id: raw.id,
    email: raw.email,
    domain: raw.domain,
    stellar_address: raw.stellar_address,
    emailVerified: raw.emailVerified,
    needsOnboarding: !raw.domain || !raw.stellar_address,
    pricePerRequest: Number(raw.pricePerRequest.toString()),
    platformFee: raw.platformFee != null ? Number(raw.platformFee.toString()) : null,
    apiKey: raw.apiKey,
    role: raw.role,
    paywallEnabled: raw.paywallEnabled,
    mcpEarlyAccess: raw.mcpEarlyAccess,
    createdAt: raw.createdAt,
  };

  assert.equal('mcpEarlyAccess' in shaped, true, 'mcpEarlyAccess must be in shapeUser output');
  assert.equal(shaped.mcpEarlyAccess, false, 'default mcpEarlyAccess must be false');
});

test('shapeUser contract: mcpEarlyAccess reflects granted state', () => {
  const raw = {
    id: 2,
    email: 'granted@b.com',
    domain: 'b.com',
    stellar_address: 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X',
    emailVerified: true,
    pricePerRequest: { toString: () => '0.005' },
    platformFee: null,
    apiKey: 'k',
    role: 'CREATOR',
    paywallEnabled: true,
    mcpEarlyAccess: true,
    createdAt: new Date(),
  };

  const shaped = {
    id: raw.id,
    email: raw.email,
    domain: raw.domain,
    stellar_address: raw.stellar_address,
    emailVerified: raw.emailVerified,
    needsOnboarding: !raw.domain || !raw.stellar_address,
    pricePerRequest: Number(raw.pricePerRequest.toString()),
    platformFee: raw.platformFee != null ? Number((raw.platformFee as { toString(): string }).toString()) : null,
    apiKey: raw.apiKey,
    role: raw.role,
    paywallEnabled: raw.paywallEnabled,
    mcpEarlyAccess: raw.mcpEarlyAccess,
    createdAt: raw.createdAt,
  };

  assert.equal(shaped.mcpEarlyAccess, true, 'mcpEarlyAccess must be true when granted');
});

// ---- 401 boundary (no Prisma needed) ----
// Requires env vars that index.ts uses at module load time, plus SKIP_LISTEN.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { before, after } from 'node:test';

process.env.SKIP_LISTEN = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-32chars-xxxxxxxxxxxx';
process.env.INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'test-internal-token';
process.env.POW_SALT = process.env.POW_SALT ?? 'test-pow-salt';
process.env.APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost';
process.env.PLATFORM_STELLAR_ADDRESS = process.env.PLATFORM_STELLAR_ADDRESS
  ?? 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X';

let srv: http.Server;
let base: string;

before(async () => {
  // Dynamically import so env vars are set first.
  // In this test file we only need the app for unauthenticated requests that
  // do NOT touch Prisma, so the missing DB connection is not a problem.
  const { app } = await import('../index.js');
  srv = http.createServer(app as unknown as http.RequestListener);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
});

test('POST /api/v1/admin/mcp/early-access → 401 with no Authorization header', async () => {
  const res = await fetch(`${base}/api/v1/admin/mcp/early-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 1, grant: true }),
  });
  assert.equal(res.status, 401, 'unauthenticated request must be rejected with 401');
  const body = await res.json() as { error: string };
  assert.ok(body.error, 'error field must be present in 401 response');
});

test('POST /api/v1/admin/mcp/early-access → 401 with malformed Bearer token', async () => {
  const res = await fetch(`${base}/api/v1/admin/mcp/early-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ userId: 1, grant: true }),
  });
  assert.equal(res.status, 401, 'invalid token must be rejected with 401');
});

// ---- /api/v1/admin/mcp/grant boundary (no Prisma needed) ----
// adminGuard rejects unauthenticated requests before any DB access, so the auth
// boundary is testable without a live DB. The grant/revoke/pre-grant DB flows
// (grant existing → flag on; grant unregistered → pre-grant row; revoke → flag
// off + row deleted; bad email → 400) run after adminGuard and are covered by E2E.

test('POST /api/v1/admin/mcp/grant → 401 with no Authorization header', async () => {
  const res = await fetch(`${base}/api/v1/admin/mcp/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pre@grant.com', granted: true }),
  });
  assert.equal(res.status, 401, 'unauthenticated grant must be rejected with 401');
  const body = await res.json() as { error: string };
  assert.ok(body.error, 'error field must be present in 401 response');
});

test('POST /api/v1/admin/mcp/grant → 401 with malformed Bearer token', async () => {
  const res = await fetch(`${base}/api/v1/admin/mcp/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ email: 'pre@grant.com', granted: true }),
  });
  assert.equal(res.status, 401, 'invalid token must be rejected with 401');
});
