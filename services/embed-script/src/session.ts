// Session storage (sessionStorage, domain-scoped) + the vx_session cookie that lets
// the WordPress plugin verify a returning human server-side. Survives the tab only.

const SESSION_PREFIX = 'vx_s_';

export function getSession(domain: string): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + domain);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token: string; expiresAt: number };
    if (Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(SESSION_PREFIX + domain);
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function clearSession(domain: string): void {
  try {
    sessionStorage.removeItem(SESSION_PREFIX + domain);
  } catch {
    /* ignore */
  }
}

export function saveSession(domain: string, token: string, ttlSeconds: number): void {
  try {
    sessionStorage.setItem(
      SESSION_PREFIX + domain,
      JSON.stringify({ token, expiresAt: Date.now() + ttlSeconds * 1000 }),
    );
  } catch {
    /* sessionStorage may be blocked (strict private mode) — not fatal */
  }
  // Cookie so the WordPress plugin can verify the session server-side.
  // SameSite=Lax: sent on same-site navigation, not cross-site requests.
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `vx_session=${token}; path=/; SameSite=Lax${secure}; max-age=${ttlSeconds}`;
  } catch {
    /* cookie may be blocked (sandboxed iframe) — not fatal */
  }
}
