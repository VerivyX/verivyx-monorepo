import net from 'node:net';

// isBlockedIp reports whether an IP address is in a non-public range that must
// never be the target of a server-initiated callback (SSRF defense).
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8 (unspecified)
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true; // not a valid IP literal → block (defensive)
}

// isValidPublicHost reports whether a string is a plausible public DNS hostname
// (not an IP literal, no port, no userinfo, has a dot, sane charset/length).
export function isValidPublicHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.includes('@') || host.includes(':') || host.includes('/')) return false;
  if (net.isIP(host) !== 0) return false; // reject IP literals
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (!host.includes('.')) return false;
  return /^[a-z0-9.-]+$/i.test(host) && !host.startsWith('.') && !host.endsWith('.');
}
