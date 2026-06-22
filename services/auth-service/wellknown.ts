import dns from 'node:dns/promises';
import { isBlockedIp, isValidPublicHost } from './ssrf.js';

const WELL_KNOWN_PATH = '/.well-known/verivyx.txt';
const FETCH_TIMEOUT_MS = 5_000;

// verifyWellKnown fetches https://<site>/.well-known/verivyx.txt (SSRF-guarded,
// 5s timeout, redirects refused) and returns true iff the trimmed body exactly
// matches expectedNonce. Throws Error('invalid_site') for non-public/blocked
// hosts. Returns false for any network/HTTP failure.
// `baseUrlOverride` is for tests only; production always uses https://<site>.
export async function verifyWellKnown(
  site: string,
  expectedNonce: string,
  baseUrlOverride?: string,
): Promise<boolean> {
  if (!isValidPublicHost(site)) throw new Error('invalid_site');
  if (!baseUrlOverride) {
    let addrs: string[];
    try {
      addrs = (await dns.lookup(site, { all: true })).map((a) => a.address);
    } catch {
      return false;
    }
    if (addrs.length === 0 || addrs.some(isBlockedIp)) throw new Error('invalid_site');
  }
  const base = baseUrlOverride ?? `https://${site}`;
  const url = `${base}${WELL_KNOWN_PATH}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'error', signal: ctrl.signal });
    if (!resp.ok) return false;
    const body = await resp.text();
    return body.trim() === expectedNonce;
  } catch (e) {
    if (e instanceof Error && e.message === 'invalid_site') throw e;
    return false;
  } finally {
    clearTimeout(timer);
  }
}
