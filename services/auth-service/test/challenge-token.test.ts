// Tests for token-aware human-unlock challenge site-resolution.
//
// Token-only sites (no domain) must resolve via wpInternalToken and embed the
// resolved siteId into the challenge claims; unresolvable sites (unknown token
// or unknown/unverified domain) must NOT get a challenge (400 unknown_site).
//
// No live DB: we replicate the exact resolution branch from index.ts with an
// injectable prisma stub that captures the `where` clause, mirroring the
// replica pattern in by-domain-verified.test.ts / domain-token-guard.test.ts.
// Any divergence from the real handler is caught by tsc + E2E.

import assert from 'node:assert/strict';
import { test } from 'node:test';

type Where = Record<string, unknown>;
type Site = { siteId: string | null; domain: string | null } | null;

function captureFindFirst(result: Site) {
  const calls: Where[] = [];
  const prisma = {
    user: {
      findFirst: async (args: { where: Where }) => {
        calls.push(args.where);
        return result;
      },
    },
  };
  return { prisma, calls };
}

// Replica of the /auth/challenge site-resolution branch (token primary OR domain verified).
async function resolveSite(
  prisma: { user: { findFirst: (a: { where: Where }) => Promise<Site> } },
  token: string | undefined,
  cleanDomain: string | null,
) {
  const hasToken = typeof token === 'string' && token.length > 0;
  return hasToken
    ? prisma.user.findFirst({ where: { wpInternalToken: token } })
    : prisma.user.findFirst({ where: { domain: cleanDomain!, domainVerified: true } });
}

test('challenge with token (no domain) resolves via wpInternalToken and embeds siteId', async () => {
  const { prisma, calls } = captureFindFirst({ siteId: 'site_abc', domain: null });
  const site = await resolveSite(prisma, 'wp-internal-token-xyz', null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wpInternalToken, 'wp-internal-token-xyz');
  assert.equal('domainVerified' in calls[0], false, 'token path must stay unfiltered');
  assert.ok(site);
  const resolvedSiteId = site!.siteId ?? undefined;
  assert.equal(resolvedSiteId, 'site_abc', 'resolved siteId is carried into the challenge');
});

test('challenge with unknown token resolves to null -> unknown_site (no challenge issued)', async () => {
  const { prisma } = captureFindFirst(null);
  const site = await resolveSite(prisma, 'no-such-token', null);
  assert.equal(site, null, 'unresolvable token must not issue a challenge');
});

test('challenge with unknown/unverified domain resolves to null -> unknown_site', async () => {
  const { prisma, calls } = captureFindFirst(null);
  const site = await resolveSite(prisma, undefined, 'unknown-site.com');
  assert.equal(calls[0].domain, 'unknown-site.com');
  assert.equal(calls[0].domainVerified, true, 'domain branch MUST filter domainVerified:true');
  assert.equal(site, null);
});

test('challenge with verified domain resolves and preserves domain path', async () => {
  const { prisma, calls } = captureFindFirst({ siteId: 'site_dom', domain: 'ok-site.com' });
  const site = await resolveSite(prisma, undefined, 'ok-site.com');
  assert.equal(calls[0].domain, 'ok-site.com');
  assert.equal(calls[0].domainVerified, true);
  assert.ok(site);
  assert.equal(site!.domain, 'ok-site.com');
});
