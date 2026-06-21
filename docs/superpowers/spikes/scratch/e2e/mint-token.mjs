// Drive Hydra authorization_code flow to mint a USER access token for a test sub.
// Login + consent are accepted server-side via the Hydra ADMIN API (we bypass the
// production URLS_LOGIN/URLS_CONSENT redirect targets). Audience gets MCP_RESOURCE_URI.
//
// Run inside docker on verivyx_paywall_net (reaches hydra:4444 public + hydra:4445 admin).
// Env: CLIENT_ID, CLIENT_SECRET, TEST_SUB, MCP_RESOURCE_URI, REDIRECT_URI

const PUB = "http://hydra:4444";
const ADMIN = "http://hydra:4445";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TEST_SUB = process.env.TEST_SUB;
const AUD = process.env.MCP_RESOURCE_URI;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Simple cookie jar across redirects on the hydra public host.
const jar = new Map();
function setCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// Inside the container, hydra's self-issuer "localhost:4444" must be rewritten to
// the docker DNS name "hydra:4444" so redirects resolve to the hydra container.
function toContainerUrl(url) {
  return url.replace("http://localhost:4444", PUB);
}
async function noRedirect(url) {
  const res = await fetch(toContainerUrl(url), { redirect: "manual", headers: { cookie: cookieHeader() } });
  setCookies(res);
  return res;
}

function qp(loc, name) {
  return new URL(loc, "http://x").searchParams.get(name);
}

async function adminPut(path, body) {
  const res = await fetch(ADMIN + path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin PUT ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
async function adminGet(path) {
  const res = await fetch(ADMIN + path);
  if (!res.ok) throw new Error(`admin GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const state = "st_" + Math.random().toString(36).slice(2);
  const authUrl =
    `${PUB}/oauth2/auth?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&response_type=code&scope=${encodeURIComponent("openid offline")}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

  // 1. /oauth2/auth -> 302 to login URL carrying login_challenge
  let res = await noRedirect(authUrl);
  let loc = res.headers.get("location");
  if (!loc) throw new Error(`/oauth2/auth no redirect, status ${res.status}: ${await res.text()}`);
  const loginChallenge = qp(loc, "login_challenge");
  if (!loginChallenge) throw new Error(`no login_challenge in ${loc}`);
  console.error("login_challenge:", loginChallenge);

  // 2. Accept login via admin API with our test subject.
  const loginAccept = await adminPut(
    `/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(loginChallenge)}`,
    { subject: TEST_SUB, remember: false },
  );
  console.error("login accept redirect:", loginAccept.redirect_to);

  // 3. Follow login redirect back to hydra -> 302 to consent URL carrying consent_challenge
  res = await noRedirect(loginAccept.redirect_to);
  loc = res.headers.get("location");
  // May chain; loop until we see consent_challenge or a code.
  let consentChallenge = null;
  for (let i = 0; i < 5 && loc; i++) {
    consentChallenge = qp(loc, "consent_challenge");
    if (consentChallenge) break;
    if (qp(loc, "code") || loc.startsWith(REDIRECT_URI)) break;
    res = await noRedirect(loc);
    loc = res.headers.get("location");
  }
  if (!consentChallenge) throw new Error(`no consent_challenge; last loc=${loc}`);
  console.error("consent_challenge:", consentChallenge);

  // 4. Accept consent via admin API, granting MCP audience.
  const cr = await adminGet(
    `/admin/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(consentChallenge)}`,
  );
  const audience = Array.from(new Set([...(cr.requested_access_token_audience ?? []), AUD]));
  const consentAccept = await adminPut(
    `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(consentChallenge)}`,
    {
      grant_scope: cr.requested_scope,
      grant_access_token_audience: audience,
      remember: false,
      session: { access_token: {}, id_token: { sub: cr.subject } },
    },
  );
  console.error("consent accept redirect:", consentAccept.redirect_to);

  // 5. Follow consent redirect -> eventually the callback with ?code=...
  res = await noRedirect(consentAccept.redirect_to);
  loc = res.headers.get("location");
  let code = null;
  for (let i = 0; i < 6 && loc; i++) {
    code = qp(loc, "code");
    if (code) break;
    res = await noRedirect(loc);
    loc = res.headers.get("location");
  }
  if (!code) throw new Error(`no auth code; last loc=${loc} status=${res.status}`);
  console.error("auth code:", code.slice(0, 12) + "...");

  // 6. Exchange code for tokens.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const tokRes = await fetch(`${PUB}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const tok = await tokRes.json();
  if (!tokRes.ok) throw new Error(`token endpoint ${tokRes.status}: ${JSON.stringify(tok)}`);

  const at = tok.access_token;
  const isJwt = typeof at === "string" && at.split(".").length === 3;
  console.error("token_type:", tok.token_type, "| is_jwt:", isJwt, "| len:", at.length);
  if (isJwt) {
    const payload = JSON.parse(Buffer.from(at.split(".")[1], "base64url").toString());
    console.error("JWT claims: sub=", payload.sub, "aud=", JSON.stringify(payload.aud), "iss=", payload.iss);
  }
  // Write the token to a file for capture (keep it off stdout/terminal).
  const fs = await import("node:fs");
  fs.writeFileSync("/work/token.txt", at);
  console.error("token written to token.txt (", at.length, "bytes)");
})().catch((e) => {
  console.error("MINT FAIL:", e.message);
  process.exit(1);
});
