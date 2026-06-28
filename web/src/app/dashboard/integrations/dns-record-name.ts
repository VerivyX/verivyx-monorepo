// Compute the DNS record Name/Host for an apex TXT verification on `domain`.
// Heuristic: a 2-label domain (example.com) is an apex -> "@"; a deeper domain
// (web-test.verivyx.com) is a subdomain -> the labels before the registrable
// root (web-test). Note: assumes a single-label public TLD (.com/.io/...); a
// multi-part TLD (.co.uk) would need a public-suffix list — uncommon for this audience,
// and the full record name (host) is always shown as the authoritative fallback.
export function dnsRecordName(domain: string): { host: string; name: string } {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  const name = labels.length > 2 ? labels.slice(0, labels.length - 2).join(".") : "@";
  return { host, name };
}
