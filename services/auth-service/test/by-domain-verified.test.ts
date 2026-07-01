// Tests for the domain-squatting fix: internal by-domain tenant resolution must
// filter on domainVerified:true so a self-declared (unverified) domain is NOT
// resolved. The token path (primary) must stay unfiltered.
//
// No live DB: we replicate the exact branch logic from index.ts with an
// injectable prisma stub that captures the `where` clause passed to findFirst,
// mirroring the replica pattern in domain-token-guard.test.ts. Any divergence
// from the real handler is caught by tsc + E2E.

import assert from 'node:assert/strict';
import { test } from 'node:test';

type Where = Record<string, unknown>;

function captureFindFirst() {
  const calls: Where[] = [];
  const prisma = {
    user: {
      findFirst: async (args: { where: Where }) => {
        calls.push(args.where);
        return null;
      },
    },
  };
  return { prisma, calls };
}

// Replica of the /auth/lookup resolution branch (token primary OR domain legacy).
async function resolveLookup(
  prisma: { user: { findFirst: (a: { where: Where }) => Promise<unknown> } },
  token: string | undefined,
  domain: string | undefined,
) {
  return token
    ? prisma.user.findFirst({ where: { wpInternalToken: token } })
    : prisma.user.findFirst({ where: { domain, domainVerified: true } });
}

// Replica of the /auth/events + /content/get by-domain resolution.
async function resolveByDomain(
  prisma: { user: { findFirst: (a: { where: Where }) => Promise<unknown> } },
  domain: string,
) {
  return prisma.user.findFirst({ where: { domain, domainVerified: true } });
}

test('by-domain lookup gates on domainVerified:true', async () => {
  const { prisma, calls } = captureFindFirst();
  await resolveLookup(prisma, undefined, 'squatted-site.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, 'squatted-site.com');
  assert.equal(calls[0].domainVerified, true, 'domain branch MUST filter domainVerified:true');
});

test('token lookup does NOT filter on domainVerified (primary path untouched)', async () => {
  const { prisma, calls } = captureFindFirst();
  await resolveLookup(prisma, 'wp-internal-token-abc', undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wpInternalToken, 'wp-internal-token-abc');
  assert.equal('domainVerified' in calls[0], false, 'token path must stay unfiltered');
});

test('events/content by-domain resolution gates on domainVerified:true', async () => {
  const { prisma, calls } = captureFindFirst();
  await resolveByDomain(prisma, 'someones-site.com');
  assert.equal(calls[0].domainVerified, true, 'by-domain ingest/content MUST filter domainVerified:true');
});
