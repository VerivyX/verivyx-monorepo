import { createHash, timingSafeEqual } from "node:crypto";

export type ApiKeyEntry = { label: string; sha256: string };

const HEX64 = /^[0-9a-f]{64}$/i;

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseApiKeys(raw: string): ApiKeyEntry[] {
  const out: ApiKeyEntry[] = [];
  let n = 0;
  for (const part of raw.split(",").map(p => p.trim()).filter(Boolean)) {
    n++;
    const idx = part.indexOf(":");
    if (idx > 0 && HEX64.test(part.slice(idx + 1))) {
      out.push({ label: part.slice(0, idx), sha256: part.slice(idx + 1).toLowerCase() });
    } else {
      out.push({ label: `key${n}`, sha256: sha256Hex(part) });
    }
  }
  return out;
}

export function matchApiKey(presented: string, entries: readonly ApiKeyEntry[]): string | null {
  const presentedHash = Buffer.from(sha256Hex(presented), "hex");
  let label: string | null = null;
  for (const e of entries) {
    const candidate = Buffer.from(e.sha256, "hex");
    if (candidate.length === presentedHash.length && timingSafeEqual(candidate, presentedHash)) {
      label = e.label;
    }
  }
  return label;
}
