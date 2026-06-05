// Pure helpers — extracted so tests don't load the express app.

import crypto from 'node:crypto';

export const DOMAIN_REGEX = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
export const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let v = input.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN_REGEX.test(v)) return null;
  return v;
}

export function validateStellar(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  return STELLAR_PUBKEY_REGEX.test(v) ? v : null;
}

export function validateSlug(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  return SLUG_REGEX.test(v) ? v : null;
}

export function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let i = 7; i >= 0; i--) {
      if ((byte >> i) & 1) return bits;
      bits += 1;
    }
    return bits;
  }
  return bits;
}

export function checkPow(challenge: string, salt: string, nonce: string, difficulty: number): boolean {
  const digest = crypto
    .createHash('sha256')
    .update(`${challenge}:${salt}:${nonce}`)
    .digest();
  return leadingZeroBits(digest) >= difficulty;
}

export interface Fingerprint {
  webdriver?: boolean;
  languages?: string[];
  hardwareConcurrency?: number;
  screenWidth?: number;
  screenHeight?: number;
  userAgent?: string;
  webglVendor?: string;
  webglRenderer?: string;
  mouseMoved?: boolean;
}

export function fingerprintReason(fp: Fingerprint): string | null {
  if (!fp || typeof fp !== 'object') return 'fingerprint_missing';
  if (fp.webdriver === true) return 'webdriver_flag_set';
  if (!Array.isArray(fp.languages) || fp.languages.length === 0) return 'no_languages';
  if (typeof fp.userAgent !== 'string' || fp.userAgent.length < 8) return 'bad_user_agent';
  const ua = fp.userAgent.toLowerCase();
  if (/headless|phantomjs|electron\/|puppeteer|playwright|selenium/.test(ua)) return 'headless_user_agent';
  if (/(?:bot|spider|crawler|scrap|gptbot|claudebot|perplexity|bytespider|google-extended)/.test(ua))
    return 'bot_user_agent';
  if (typeof fp.hardwareConcurrency !== 'number' || fp.hardwareConcurrency <= 0 || fp.hardwareConcurrency > 128)
    return 'cpu_anomaly';
  if (
    typeof fp.screenWidth !== 'number' ||
    typeof fp.screenHeight !== 'number' ||
    fp.screenWidth < 100 ||
    fp.screenHeight < 100
  )
    return 'screen_anomaly';
  if (typeof fp.webglVendor === 'string') {
    const vendor = fp.webglVendor.toLowerCase();
    if (/swiftshader|software/.test(vendor)) return 'software_gpu';
    if (/llvmpipe|virgl/.test(vendor)) return 'vm_gpu';
  }
  if (typeof fp.webglRenderer === 'string') {
    const renderer = fp.webglRenderer.toLowerCase();
    if (/swiftshader|software/.test(renderer)) return 'software_gpu';
    if (/llvmpipe|virgl/.test(renderer)) return 'vm_gpu';
  }
  return null;
}
