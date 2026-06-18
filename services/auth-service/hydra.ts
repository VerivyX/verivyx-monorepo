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
  return hydraRequest(
    `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, remember: true, remember_for: 86400, ...opts }),
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
