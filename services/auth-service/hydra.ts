// Hydra admin client — all calls go server-side to HYDRA_ADMIN_URL (internal).
// Never expose the admin port to the public.

const HYDRA_ADMIN_URL = (process.env.HYDRA_ADMIN_URL ?? 'http://hydra:4445').replace(/\/$/, '');

async function hydraRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hydra ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Login ──────────────────────────────────────────────────────────────────

export async function getLoginRequest(challenge: string): Promise<{ skip: boolean; subject: string; client: any }> {
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login?login_challenge=${encodeURIComponent(challenge)}`,
  );
}

export async function acceptLogin(
  challenge: string,
  subject: string,
  opts?: Record<string, unknown>,
): Promise<{ redirect_to: string }> {
  // subject is placed LAST so that any `opts` entry named "subject" cannot override
  // the authenticated identity. This is the footgun fix from the T2 review.
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remember: true, remember_for: 86400, ...opts, subject }),
    },
  );
}

export async function rejectLogin(challenge: string, error: string): Promise<{ redirect_to: string }> {
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/reject?login_challenge=${encodeURIComponent(challenge)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    },
  );
}

// ── Consent ────────────────────────────────────────────────────────────────

export async function getConsentRequest(challenge: string): Promise<{
  skip: boolean;
  subject: string;
  requested_scope: string[];
  requested_access_token_audience: string[];
  client: any;
}> {
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(challenge)}`,
  );
}

export async function acceptConsent(
  challenge: string,
  { grantScope, grantAudience, sessionSub }: { grantScope: string[]; grantAudience: string[]; sessionSub: string },
): Promise<{ redirect_to: string }> {
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(challenge)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_scope: grantScope,
        grant_access_token_audience: grantAudience,
        remember: true,
        remember_for: 86400,
        session: { access_token: {}, id_token: { sub: sessionSub } },
      }),
    },
  );
}

export async function rejectConsent(challenge: string, error: string): Promise<{ redirect_to: string }> {
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent/reject?consent_challenge=${encodeURIComponent(challenge)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    },
  );
}

// ── Logout / session revocation ──────────────────────────────────────────────

// Invalidate Hydra's SSO for a subject so the NEXT authorize flow requires a
// fresh login (Hydra's `skip` no longer auto-accepts). This deletes the login +
// consent sessions only; it does NOT revoke already-issued access tokens —
// existing connectors keep working until their token expires.
//
// Best-effort: never throws. A failure here must not break dashboard logout, so
// non-2xx is logged and swallowed. (Hydra returns 204 No Content on success.)
export async function revokeUserSessions(subject: string): Promise<void> {
  const targets = [
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/sessions/login?subject=${encodeURIComponent(subject)}`,
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/sessions/consent?subject=${encodeURIComponent(subject)}`,
  ];
  for (const url of targets) {
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`Hydra revokeUserSessions ${res.status} for ${url}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error('Hydra revokeUserSessions error:', err instanceof Error ? err.message : err);
    }
  }
}
