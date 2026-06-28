import { randomBytes } from 'node:crypto';

export function newSiteId(): string {
  return 'site_' + randomBytes(12).toString('hex');
}

export function onchainKey(u: { domain?: string | null; siteId?: string | null }): string {
  const d = (u.domain ?? '').trim();
  if (d) return d;
  const s = (u.siteId ?? '').trim();
  if (s) return s;
  throw new Error('onchainKey: no domain or siteId');
}

// Human-readable label for a tenant in analytics/admin views (Task 64).
// Prefers the legacy domain; falls back to siteId, then any extra label (e.g.
// the creator email), then a placeholder. Never throws.
export function siteLabel(u: { domain?: string | null; siteId?: string | null; fallback?: string | null }): string {
  const d = (u.domain ?? '').trim();
  if (d) return d;
  const s = (u.siteId ?? '').trim();
  if (s) return s;
  const f = (u.fallback ?? '').trim();
  if (f) return f;
  return 'unknown';
}
