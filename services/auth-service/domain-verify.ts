import dns from 'node:dns/promises';
import { isValidPublicHost } from './ssrf.js';

const RESOLVE_TIMEOUT_MS = 5_000;
const TXT_PREFIX = 'verivyx-site-verification=';

// verifyDomainTxt resolves the apex TXT records for `site` and returns true iff any
// record equals `verivyx-site-verification=<expectedNonce>`. Throws Error('invalid_site')
// for a non-public/invalid host. Returns false when no matching record is found
// (incl. ENOTFOUND / ENODATA / no TXT / timeout). No HTTP request is made, so the SSRF
// connection guard is unnecessary here. `resolverOverride` is for tests only.
export async function verifyDomainTxt(
  site: string,
  expectedNonce: string,
  resolverOverride?: (host: string) => Promise<string[][]>,
): Promise<boolean> {
  if (!isValidPublicHost(site)) throw new Error('invalid_site');
  const resolveTxt = resolverOverride ?? ((h: string) => dns.resolveTxt(h));
  const expected = `${TXT_PREFIX}${expectedNonce}`;
  let records: string[][];
  try {
    records = await withTimeout(resolveTxt(site), RESOLVE_TIMEOUT_MS);
  } catch {
    return false;
  }
  return records.some((chunks) => chunks.join('').trim() === expected);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}
