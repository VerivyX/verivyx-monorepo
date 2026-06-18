// Hydra admin client tests. Uses mock global fetch — no real Hydra needed.
import assert from 'node:assert/strict';
import { test, before, mock } from 'node:test';

const ADMIN_URL = 'http://hydra-test:4445';

process.env.HYDRA_ADMIN_URL = ADMIN_URL;

let getLoginRequest: (challenge: string) => Promise<{ skip: boolean; subject: string; client: any }>;
let acceptLogin: (challenge: string, subject: string, opts?: Record<string, unknown>) => Promise<{ redirect_to: string }>;
let rejectLogin: (challenge: string, error: string) => Promise<{ redirect_to: string }>;
let getConsentRequest: (challenge: string) => Promise<{ skip: boolean; subject: string; requested_scope: string[]; requested_access_token_audience: string[]; client: any }>;
let acceptConsent: (challenge: string, opts: { grantScope: string[]; grantAudience: string[]; sessionSub: string }) => Promise<{ redirect_to: string }>;
let rejectConsent: (challenge: string, error: string) => Promise<{ redirect_to: string }>;

before(async () => {
  const mod = await import('../hydra.js');
  getLoginRequest = mod.getLoginRequest;
  acceptLogin = mod.acceptLogin;
  rejectLogin = mod.rejectLogin;
  getConsentRequest = mod.getConsentRequest;
  acceptConsent = mod.acceptConsent;
  rejectConsent = mod.rejectConsent;
});

// Helper: make a mock fetch that returns JSON.
function mockFetch(body: unknown, status = 200) {
  const bodyText = JSON.stringify(body);
  return mock.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => bodyText,
  }));
}

test('getLoginRequest issues GET to correct URL and returns parsed body', async () => {
  const payload = { skip: false, subject: '', client: {} };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await getLoginRequest('challenge-abc');

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit | undefined];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/login?login_challenge=challenge-abc`);
  assert.equal(init?.method ?? 'GET', 'GET');
  assert.deepEqual(result, payload);
});

test('acceptLogin issues PUT with correct URL, body containing subject, returns redirect_to', async () => {
  const payload = { redirect_to: 'https://hydra.test/callback' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await acceptLogin('c1', 'user-123');

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/login/accept?login_challenge=c1`);
  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.subject, 'user-123');
  assert.equal(sent.remember, true);
  assert.equal(sent.remember_for, 86400);
  assert.deepEqual(result, payload);
});

test('rejectLogin issues PUT to reject URL with error description', async () => {
  const payload = { redirect_to: 'https://hydra.test/error' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await rejectLogin('c2', 'access_denied');

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/login/reject?login_challenge=c2`);
  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.error, 'access_denied');
  assert.deepEqual(result, payload);
});

test('getConsentRequest issues GET to consent URL and returns parsed body', async () => {
  const payload = { skip: true, subject: 'user-99', requested_scope: ['openid'], requested_access_token_audience: [], client: {} };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await getConsentRequest('cc1');

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit | undefined];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/consent?consent_challenge=cc1`);
  assert.equal(init?.method ?? 'GET', 'GET');
  assert.deepEqual(result, payload);
});

test('acceptConsent issues PUT with grant_scope, grant_access_token_audience, session, remember', async () => {
  const payload = { redirect_to: 'https://hydra.test/done' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await acceptConsent('cc2', { grantScope: ['openid', 'profile'], grantAudience: [], sessionSub: 'user-1' });

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/consent/accept?consent_challenge=cc2`);
  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body as string);
  assert.deepEqual(sent.grant_scope, ['openid', 'profile']);
  assert.deepEqual(sent.grant_access_token_audience, []);
  assert.equal(sent.remember, true);
  assert.equal(sent.remember_for, 86400);
  assert.ok('session' in sent);
  assert.deepEqual(result, payload);
});

test('rejectConsent issues PUT to reject consent URL', async () => {
  const payload = { redirect_to: 'https://hydra.test/error' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const result = await rejectConsent('cc3', 'consent_required');

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/consent/reject?consent_challenge=cc3`);
  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.error, 'consent_required');
  assert.deepEqual(result, payload);
});

test('acceptLogin throws on non-2xx response', async () => {
  const fetchMock = mockFetch({ error: 'not found' }, 404);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await assert.rejects(
    () => acceptLogin('bad', 'user-1'),
    /404/,
  );
});

test('acceptLogin: opts subject cannot override the real subject (footgun guard)', async () => {
  const payload = { redirect_to: 'https://hydra.test/callback' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Caller attempts to override subject via opts — must be silently ignored.
  await acceptLogin('c-guard', 'real-user', { subject: 'evil-user' });

  const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.subject, 'real-user', 'subject must remain the real authenticated identity');
});

test('acceptConsent audience guarantee: MCP resource URI always included in grant_access_token_audience', async () => {
  const payload = { redirect_to: 'https://hydra.test/done' };
  const fetchMock = mockFetch(payload);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const mcpUri = 'https://mcp.verivyx.com/mcp';
  await acceptConsent('c1', {
    grantScope: ['openid'],
    grantAudience: [mcpUri],
    sessionSub: 'user-123',
  });

  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `${ADMIN_URL}/admin/oauth2/auth/requests/consent/accept?consent_challenge=c1`);
  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body as string);
  assert.deepEqual(sent.grant_scope, ['openid']);
  assert.ok(
    (sent.grant_access_token_audience as string[]).includes(mcpUri),
    'grant_access_token_audience must contain the MCP resource URI',
  );
  assert.equal(sent.session?.id_token?.sub, 'user-123');
});
