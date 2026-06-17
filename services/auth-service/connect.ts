import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { isBlockedIp, isValidPublicHost } from './ssrf.js';

const PENDING_TTL_MS = 10 * 60_000;
const CONFIRM_PATH = '/wp-json/verivyx/v1/confirm';
const CONFIRM_TIMEOUT_MS = 5_000;

const urlSafe = (bytes: number) => crypto.randomBytes(bytes).toString('base64url');
export const newConnectId = (): string => urlSafe(18);
export const newNonce = (): string => urlSafe(24);
export const newCode = (): string => urlSafe(24);

export function isPendingExpired(createdAt: Date, now: number = Date.now()): boolean {
  return now - createdAt.getTime() > PENDING_TTL_MS;
}

// confirmOwnership performs the SSRF-guarded callback to the site's confirm endpoint
// and returns the nonce the plugin reports. Throws Error('invalid_site') if the host
// is not a public domain or resolves to a blocked IP; Error('confirm_failed') otherwise.
// `baseUrlOverride` is for tests only; production always uses https://<site>.
export async function confirmOwnership(site: string, connectId: string, baseUrlOverride?: string): Promise<string> {
  if (!isValidPublicHost(site)) throw new Error('invalid_site');
  if (!baseUrlOverride) {
    let addrs: string[];
    try {
      addrs = (await dns.lookup(site, { all: true })).map((a) => a.address);
    } catch {
      throw new Error('confirm_failed');
    }
    if (addrs.length === 0 || addrs.some(isBlockedIp)) throw new Error('invalid_site');
  }
  const base = baseUrlOverride ?? `https://${site}`;
  const url = `${base}${CONFIRM_PATH}?connect_id=${encodeURIComponent(connectId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'error', signal: ctrl.signal });
    if (!resp.ok) throw new Error('confirm_failed');
    const data = (await resp.json()) as { nonce?: unknown };
    if (typeof data.nonce !== 'string' || data.nonce === '') throw new Error('confirm_failed');
    return data.nonce;
  } catch (e) {
    if (e instanceof Error && e.message === 'invalid_site') throw e;
    throw new Error('confirm_failed');
  } finally {
    clearTimeout(timer);
  }
}
