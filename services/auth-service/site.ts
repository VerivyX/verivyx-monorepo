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
