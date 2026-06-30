import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  normalizeDomain,
  validateStellar,
  validateSlug,
  checkPow,
  fingerprintReason,
  clientIp as _clientIp,
  requireProductionSecrets,
  type Fingerprint,
} from './lib.js';
import {
  adaptDifficulty,
  lookup as repLookup,
  update as repUpdate,
  type Tier,
} from './reputation.js';
import { isValidPublicHost } from './ssrf.js';
import { newSiteId, onchainKey, siteLabel } from './site.js';
import { newConnectId, newNonce, newCode, isPendingExpired, confirmOwnership } from './connect.js';
import { verifyDomainTxt } from './domain-verify.js';
import { getLoginRequest, acceptLogin, getConsentRequest, acceptConsent, rejectConsent, revokeUserSessions } from './hydra.js';

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      userEmail?: string;
      domain?: string;
    }
  }
}

type AuthedRequest = Request & { userId?: number; userEmail?: string; domain?: string };

const prisma = new PrismaClient();
const app = express();
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? '1');
app.set('trust proxy', TRUSTED_PROXY_HOPS);
app.use(express.json({ limit: '256kb' }));
app.use(cors());

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) { console.error(`[FATAL] ${key} env var is required — set it in .env`); process.exit(1); }
  return v;
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const SESSION_SECRET = process.env.SESSION_SECRET || (JWT_SECRET + '_session');
const INTERNAL_TOKEN = requireEnv('INTERNAL_TOKEN');
const POW_DIFFICULTY = Number(process.env.POW_DIFFICULTY || 18);
const POW_SALT = requireEnv('POW_SALT');
const POW_MIN_SOLVE_MS = Number(process.env.POW_MIN_SOLVE_MS || 50);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const CHALLENGE_TTL_SEC = 60;
const HUMAN_SESSION_TTL_SEC = 30 * 60;

// Cloudflare Turnstile secret for the login/register gate. Empty → dev bypass
// (mirrors playground-agent). In production this MUST be set.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY?.trim() || '';
// Resend transactional email. When the API key is empty (local dev), the
// verification link is logged to the console instead of being emailed.
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || '';
const RESEND_FROM = process.env.RESEND_FROM?.trim() || 'Verivyx <noreply@verivyx.com>';
// Public base URL of the frontend (e.g. https://verivyx.com), used to build
// user-facing links such as the email verification URL. Required — never fall
// back to a hardcoded domain.
const APP_BASE_URL = requireEnv('APP_BASE_URL').replace(/\/$/, '');
// Email verification token lifetime.
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000;

// Production fail-fast: the empty-secret dev bypasses above silently disable the
// captcha gate (Turnstile) and the email hard-gate (Resend). That is acceptable
// for local dev but MUST never happen in production, so refuse to boot.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
try {
  requireProductionSecrets({
    isProduction: IS_PRODUCTION,
    TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    RESEND_API_KEY: RESEND_API_KEY,
  });
} catch (e) {
  console.error(`[FATAL] ${(e as Error).message}`);
  process.exit(1);
}
if (!IS_PRODUCTION) {
  if (!TURNSTILE_SECRET) console.warn('[dev] TURNSTILE_SECRET_KEY empty — captcha verification is BYPASSED (dev only).');
  if (!RESEND_API_KEY) console.warn('[dev] RESEND_API_KEY empty — email verification is BYPASSED, links logged to stdout (dev only).');
}

// Public frontend URL (e.g. https://verivyx.com) — used to redirect browser to
// the dashboard login page when a Hydra login challenge requires interaction.
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN?.replace(/\/$/, '') ?? APP_BASE_URL;

// ---------- in-memory rate limiter ----------
const _rl = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = _rl.get(ip);
  if (!e || e.resetAt < now) { _rl.set(ip, { count: 1, resetAt: now + windowMs }); return true; }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

function clientJa4(req: Request): string {
  const raw = req.headers['x-ja4'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.slice(0, 256) : '';
}

// ---------- token helpers ----------

type CreatorClaims = { id: number; email: string };
type ChallengeClaims = {
  domain: string;
  slug: string;
  salt: string;
  difficulty: number;
  ip: string;
  ua: string;
  ja4?: string;
  tier?: Tier;
};
type HumanClaims = { domain: string; ip: string; ua: string };

function signCreator(c: CreatorClaims): string {
  return jwt.sign(c, JWT_SECRET, { expiresIn: '7d', audience: 'creator' });
}

function verifyCreator(token: string): CreatorClaims {
  return jwt.verify(token, JWT_SECRET, { audience: 'creator' }) as CreatorClaims;
}

function signChallenge(c: ChallengeClaims): string {
  return jwt.sign(c, SESSION_SECRET, { expiresIn: CHALLENGE_TTL_SEC, audience: 'challenge' });
}

function verifyChallenge(token: string): ChallengeClaims {
  return jwt.verify(token, SESSION_SECRET, { audience: 'challenge' }) as ChallengeClaims;
}

function signHumanSession(c: HumanClaims): string {
  return jwt.sign(c, SESSION_SECRET, { expiresIn: HUMAN_SESSION_TTL_SEC, audience: 'human' });
}

function reqIp(req: Request): string {
  return _clientIp(req.headers['x-forwarded-for'], req.socket?.remoteAddress, TRUSTED_PROXY_HOPS);
}

// ---------- guards ----------

function authGuard(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  try {
    const decoded = verifyCreator(header.slice(7));
    req.userId = decoded.id;
    req.userEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function internalGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

async function adminGuard(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'Missing token' }); return; }
  let claims: CreatorClaims;
  try { claims = verifyCreator(header.slice(7)); } catch { res.status(401).json({ error: 'Invalid token' }); return; }
  const u = await prisma.user.findUnique({ where: { id: claims.id }, select: { role: true } });
  if (!u || u.role !== 'ADMIN') { res.status(403).json({ error: 'Admin access required' }); return; }
  req.userId = claims.id;
  req.userEmail = claims.email;
  next();
}

async function logAdminAction(adminId: number, action: string, target?: string, metadata?: Record<string, unknown>) {
  await prisma.adminLog.create({ data: { adminId, action, target, metadata: metadata as Prisma.InputJsonValue } }).catch(() => {});
}

// ---------- Turnstile ----------

// Verify a Cloudflare Turnstile token. Empty secret → dev bypass (local only).
async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new URLSearchParams();
  form.set('secret', TURNSTILE_SECRET);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const d = (await r.json()) as { success?: boolean };
    return Boolean(d.success);
  } catch {
    return false;
  }
}

// ---------- email verification ----------

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Create a single-use verification token for a user, returning the raw token
// (only its hash is persisted). Prior unused VERIFY tokens are cleared first.
async function createVerificationToken(userId: number): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.emailToken.deleteMany({ where: { userId, type: 'VERIFY' } });
  await prisma.emailToken.create({
    data: { userId, tokenHash: sha256(raw), type: 'VERIFY', expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS) },
  });
  return raw;
}

// Send the verification email via Resend. Without an API key (dev), log the link.
async function sendVerificationEmail(email: string, rawToken: string): Promise<void> {
  const link = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
  if (!RESEND_API_KEY) {
    console.error(`[dev] email verification link for ${email}: ${link}`);
    return;
  }
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0a0a0a">
    <h2 style="margin:0 0 12px">Verify your Verivyx email</h2>
    <p style="color:#525252;margin:0 0 20px">Confirm this address to activate your Verivyx creator account.</p>
    <a href="${link}" style="display:inline-block;background:#fdda24;color:#0a0a0a;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:10px">Verify email</a>
    <p style="color:#a3a3a3;font-size:12px;margin:24px 0 0">Or paste this link: ${link}<br/>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [email], subject: 'Verify your Verivyx email', html }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${detail.slice(0, 200)}`);
  }
}

// ---------- generic branded email (Resend) ----------

// Reply-to a real inbox (not the noreply From) — improves deliverability/trust.
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO?.trim() || process.env.ADMIN_EMAIL?.trim() || '';

// Send any email via Resend. Without an API key (dev), log instead of sending.
// Always includes a plain-text alternative (multipart) for inbox placement.
async function sendResendEmail(
  to: string,
  subject: string,
  html: string,
  opts?: { text?: string; headers?: Record<string, string> },
): Promise<void> {
  if (!RESEND_API_KEY) {
    console.error(`[dev] email to ${to}: ${subject}`);
    return;
  }
  // Derive a plain-text fallback from the HTML when none is provided.
  const text = opts?.text ?? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const payload: Record<string, unknown> = { from: RESEND_FROM, to: [to], subject, html, text };
  if (RESEND_REPLY_TO) payload.reply_to = RESEND_REPLY_TO;
  if (opts?.headers) payload.headers = opts.headers;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${detail.slice(0, 200)}`);
  }
}

// Branded HTML wrapper matching the Verivyx email style (ink + yellow).
function brandedEmail(heading: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0a0a0a">
    <div style="font-weight:800;font-size:18px;letter-spacing:-0.02em;margin:0 0 16px">Verivyx</div>
    <h2 style="margin:0 0 12px">${heading}</h2>
    ${bodyHtml}
    <p style="color:#a3a3a3;font-size:12px;margin:24px 0 0">Verivyx — the gate between creator content and the AI world.</p>
  </div>`;
}

// MCP early-access waitlist: confirmation to the user + notification to the admin.
async function sendMcpWaitlistEmails(email: string, total: number): Promise<void> {
  const userHtml = brandedEmail(
    "You're on the early-access list ✦",
    `<p style="color:#525252;margin:0 0 20px">Thanks for your interest in the <strong>Verivyx x402 MCP</strong> — one connection that lets your AI pay for any x402 resource across chains, non-custodially.</p>
     <p style="color:#525252;margin:0 0 20px">We'll email you the moment early access opens. No action needed.</p>
     <a href="https://docs.verivyx.com" style="display:inline-block;background:#fdda24;color:#0a0a0a;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:10px">Read the docs</a>`,
  );
  const unsubAddr = RESEND_REPLY_TO || 'hello@verivyx.com';
  await sendResendEmail(email, "You're on the Verivyx MCP early-access list", userHtml, {
    text:
      "You're on the early-access list for the Verivyx x402 MCP.\n\n" +
      'One connection that lets your AI pay for any x402 resource across chains, non-custodially. ' +
      "We'll email you the moment early access opens — no action needed.\n\n" +
      'Docs: https://docs.verivyx.com\n\nVerivyx — the gate between creator content and the AI world.',
    headers: { 'List-Unsubscribe': `<mailto:${unsubAddr}?subject=unsubscribe>` },
  });

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (adminEmail) {
    const adminHtml = brandedEmail(
      'New MCP early-access signup',
      `<p style="color:#525252;margin:0 0 8px">New signup: <strong>${email}</strong></p>
       <p style="color:#525252;margin:0 0 20px">Total waitlist: <strong>${total}</strong></p>
       <a href="${APP_BASE_URL}/admin/mcp" style="display:inline-block;background:#0a0a0a;color:#fff;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:10px">View waitlist</a>`,
    );
    await sendResendEmail(adminEmail, `New Verivyx MCP signup — ${email}`, adminHtml, {
      text: `New Verivyx MCP early-access signup: ${email}\nTotal waitlist: ${total}\n\nView: ${APP_BASE_URL}/admin/mcp`,
    }).catch((e) => console.error('MCP admin notify failed:', e instanceof Error ? e.message : e));
  }
}

// ---------- shape ----------

type PublicUser = {
  id: number;
  email: string;
  domain: string | null;
  stellar_address: string | null;
  emailVerified: boolean;
  needsOnboarding: boolean;
  pricePerRequest: number;
  platformFee: number | null;
  apiKey: string | null;
  role: string;
  paywallEnabled: boolean;
  mcpEarlyAccess: boolean;
  domainVerified: boolean;
  createdAt?: Date;
};

function shapeUser(u: {
  id: number;
  email: string;
  domain: string | null;
  stellar_address: string | null;
  emailVerified: boolean;
  pricePerRequest: { toString(): string };
  platformFee: { toString(): string } | null;
  apiKey: string | null;
  role: string;
  paywallEnabled: boolean;
  mcpEarlyAccess: boolean;
  domainVerified?: boolean;
  createdAt?: Date;
}): PublicUser {
  return {
    id: u.id,
    email: u.email,
    domain: u.domain,
    stellar_address: u.stellar_address,
    emailVerified: u.emailVerified,
    // Onboarding is token-only now: complete once the payout wallet is set.
    // Domain is no longer required (the SDK is configured by site token).
    needsOnboarding: !u.stellar_address,
    pricePerRequest: Number(u.pricePerRequest),
    platformFee: u.platformFee != null ? Number(u.platformFee) : null,
    apiKey: u.apiKey,
    role: u.role,
    paywallEnabled: u.paywallEnabled,
    mcpEarlyAccess: u.mcpEarlyAccess,
    domainVerified: u.domainVerified ?? false,
    createdAt: u.createdAt,
  };
}

// ---------- routes ----------

app.get('/api/v1/auth/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Creator auth ---

// Register collects only email + password (+ Turnstile). Wallet and domain are
// gathered later in the onboarding wizard. The account starts UNVERIFIED and a
// verification email is sent; the user cannot log in until they verify.
app.post('/api/v1/auth/register', async (req: Request, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(ip, 5, 60 * 60_000)) {
    return res.status(429).json({ error: 'Too many registrations from this IP. Try again in an hour.' });
  }
  const { email, password, turnstileToken } = req.body ?? {};

  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!(await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : '', ip))) {
    return res.status(403).json({ error: 'Captcha verification failed' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const normalizedEmail = email.trim().toLowerCase();
    // Issue a stable siteId and a site token (the SDK's VERIVYX_TOKEN, stored in
    // the same wpInternalToken column used by WP Connect / DNS provisioning) at
    // signup so the account is SDK-ready with no DNS step required.
    const siteToken = crypto.randomBytes(30).toString('base64url'); // 40-char url-safe secret
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        siteId: newSiteId(),
        wpInternalToken: siteToken,
      },
    });
    // Apply any admin pre-grant for this email (case-insensitive) so a waitlisted
    // creator gets MCP early access the moment they register.
    const grant = await prisma.mcpEarlyAccessGrant.findUnique({ where: { email: normalizedEmail } });
    if (grant) {
      await prisma.user.update({ where: { id: user.id }, data: { mcpEarlyAccess: true } });
    }
    const rawToken = await createVerificationToken(user.id);
    try {
      await sendVerificationEmail(user.email, rawToken);
    } catch (e) {
      // Account exists but the email failed — let the user resend rather than fail hard.
      console.error('Verification email send failed:', e instanceof Error ? e.message : e);
    }
    res.status(201).json({ status: 'success', requiresVerification: true, email: user.email });
  } catch (error: any) {
    console.error('Registration Error:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify an email via the link token. On success the account is marked verified
// and a session token is returned (auto-login → onboarding).
app.post('/api/v1/auth/verify-email', async (req: Request, res: Response) => {
  if (!rateLimit(reqIp(req), 20, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }
  const { token } = req.body ?? {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Verification token is required' });
  }
  try {
    const row = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== 'VERIFY' || row.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    }
    const user = await prisma.user.update({ where: { id: row.userId }, data: { emailVerified: true } });
    await prisma.emailToken.deleteMany({ where: { userId: row.userId, type: 'VERIFY' } });
    const sessionToken = signCreator({ id: user.id, email: user.email });
    res.json({ status: 'success', token: sessionToken, user: shapeUser(user) });
  } catch (error) {
    console.error('Verify Email Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend a verification email. Always returns success to avoid leaking which
// emails are registered.
app.post('/api/v1/auth/resend-verification', async (req: Request, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(`resend:${ip}`, 5, 60 * 60_000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  const { email } = req.body ?? {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (user && !user.emailVerified) {
      const rawToken = await createVerificationToken(user.id);
      await sendVerificationEmail(user.email, rawToken).catch((e) =>
        console.error('Resend email failed:', e instanceof Error ? e.message : e),
      );
    }
    res.json({ status: 'success' });
  } catch (error) {
    console.error('Resend Verification Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// MCP early-access waitlist (public, mcp.verivyx.com coming-soon).
// Generic success even on duplicates to avoid leaking who has signed up.
app.post('/api/v1/mcp-waitlist', async (req: Request, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(`mcpwl:${ip}`, 10, 60 * 60_000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  const { email, turnstileToken } = req.body ?? {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  // Authenticated dashboard users (valid creator JWT) skip the captcha — they're already
  // verified. The public mcp.verivyx.com coming-soon path still requires Turnstile.
  let authed = false;
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    try { verifyCreator(authz.slice(7)); authed = true; } catch { /* not authenticated → public path */ }
  }
  if (!authed && !(await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : '', ip))) {
    return res.status(403).json({ error: 'Captcha verification failed' });
  }
  const normalized = email.trim().toLowerCase();
  try {
    const existing = await prisma.mcpWaitlist.findUnique({ where: { email: normalized } });
    if (!existing) {
      await prisma.mcpWaitlist.create({ data: { email: normalized } });
      const total = await prisma.mcpWaitlist.count();
      await sendMcpWaitlistEmails(normalized, total).catch((e) =>
        console.error('MCP waitlist email failed:', e instanceof Error ? e.message : e),
      );
    }
    res.json({ status: 'success' });
  } catch (error) {
    console.error('MCP Waitlist Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/v1/auth/login', async (req: Request, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(ip, 10, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { email, password, turnstileToken } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (!(await verifyTurnstile(typeof turnstileToken === 'string' ? turnstileToken : '', ip))) {
    return res.status(403).json({ error: 'Captcha verification failed' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'email_not_verified', detail: 'Please verify your email before logging in.' });
    }
    const token = signCreator({ id: user.id, email: user.email });
    res.json({ status: 'success', token, user: shapeUser(user) });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/v1/auth/me', authGuard, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: shapeUser(user) });
});

// --- Hydra OAuth2 login challenge ---

// Browser redirect target from Hydra. Reads the login_challenge, checks whether
// Hydra says the session can be skipped (already authenticated), and either
// accepts immediately or bounces the user to the dashboard login page which
// will call POST /api/v1/oauth/login/accept after the user logs in.
// NOTE: auth-service uses Bearer-JWT, not cookies, so there is no usable session
// for a raw browser hit. Hydra's skip flag handles the re-auth-not-needed case.
app.get('/api/v1/oauth/login', async (req: Request, res: Response) => {
  const challenge = typeof req.query.login_challenge === 'string' ? req.query.login_challenge : '';
  if (!challenge) {
    return res.status(400).json({ error: 'login_challenge query param required' });
  }
  try {
    const lr = await getLoginRequest(challenge);
    if (lr.skip) {
      const { redirect_to } = await acceptLogin(challenge, lr.subject);
      return res.redirect(302, redirect_to);
    }
    return res.redirect(302, `${PUBLIC_DOMAIN}/login?login_challenge=${encodeURIComponent(challenge)}`);
  } catch (err) {
    console.error('Hydra getLoginRequest error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

// Called by the dashboard after a successful Bearer-JWT login when a
// login_challenge is present. Returns redirect_to so the client can navigate.
app.post('/api/v1/oauth/login/accept', authGuard, async (req: Request, res: Response) => {
  const { login_challenge } = req.body ?? {};
  if (typeof login_challenge !== 'string' || !login_challenge) {
    return res.status(400).json({ error: 'login_challenge required' });
  }
  try {
    const { redirect_to } = await acceptLogin(login_challenge, String(req.userId!));
    return res.json({ redirect_to });
  } catch (err) {
    console.error('Hydra acceptLogin error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

// --- Hydra logout ---
//
// Dashboard logout calls this to END the user's Hydra SSO session so a NEW MCP
// connector cannot silently re-authorize (Hydra's `skip` auto-accept) without a
// fresh login. Best-effort: never hard-fails — already-issued access tokens are
// intentionally NOT revoked, so live connectors keep working until token expiry.
app.post('/api/v1/oauth/logout', authGuard, async (req: Request, res: Response) => {
  await revokeUserSessions(String(req.userId!)).catch(() => {});
  return res.json({ ok: true });
});

// MCP resource URI that every issued access token must carry as audience.
// Defaults to the production value; wired into docker-compose in T7.
const MCP_RESOURCE_URI = (process.env.MCP_RESOURCE_URI ?? 'https://mcp.verivyx.com/mcp').replace(/\/$/, '');

// --- Hydra OAuth2 consent challenge ---
//
// Browser redirect target from Hydra. Auto-accepts consent because Verivyx is a
// first-party AS (not a third-party proxy) — the user already authenticated at
// the login step. A user-facing consent screen is deferred to Fase 2 polish.
//
// Critical job: always include MCP_RESOURCE_URI in grant_access_token_audience so
// tokens carry the correct `aud` even when the client (e.g. Claude) omits the
// `resource` parameter.
// Feature flag: when OFF (default), consent is auto-accepted (first-party
// convenience — the historical behavior). When ON, the user sees an explicit
// consent screen for each new app. Flip via env without redeploying code
// elsewhere — instant rollback if the browser flow misbehaves.
const CONSENT_SCREEN_ENABLED = (process.env.CONSENT_SCREEN_ENABLED ?? 'false').toLowerCase() === 'true';

// Accept the consent grant. Audience ALWAYS includes MCP_RESOURCE_URI so issued
// tokens carry the right `aud` even when the client omits the `resource` param.
// Shared by the auto-accept/skip path and the explicit user-approval endpoint.
async function grantConsent(challenge: string): Promise<string> {
  const cr = await getConsentRequest(challenge);
  const audience = Array.from(
    new Set([...(cr.requested_access_token_audience ?? []), MCP_RESOURCE_URI]),
  );
  const { redirect_to } = await acceptConsent(challenge, {
    grantScope: cr.requested_scope,
    grantAudience: audience,
    sessionSub: cr.subject,
  });
  return redirect_to;
}

// Only users granted MCP early-access may connect an MCP client. Subject = String(user.id).
async function subjectHasMcpAccess(subject: string): Promise<boolean> {
  const id = Number(subject);
  if (!Number.isInteger(id)) return false;
  const u = await prisma.user.findUnique({ where: { id } });
  return u?.mcpEarlyAccess === true;
}

// Hydra consent redirect target.
app.get('/api/v1/oauth/consent', async (req: Request, res: Response) => {
  const challenge = typeof req.query.consent_challenge === 'string' ? req.query.consent_challenge : '';
  if (!challenge) {
    return res.status(400).json({ error: 'consent_challenge query param required' });
  }
  try {
    const cr = await getConsentRequest(challenge);
    // EARLY-ACCESS GATE: deny connect for users without MCP early access (before
    // any consent screen or grant). Rejecting returns a Hydra error redirect.
    if (!(await subjectHasMcpAccess(cr.subject))) {
      const { redirect_to } = await rejectConsent(challenge, 'access_denied');
      return res.redirect(302, redirect_to);
    }
    // Show the screen only when enabled AND Hydra doesn't already remember a grant.
    if (CONSENT_SCREEN_ENABLED && !cr.skip) {
      return res.redirect(
        302,
        `${PUBLIC_DOMAIN}/consent?consent_challenge=${encodeURIComponent(challenge)}`,
      );
    }
    return res.redirect(302, await grantConsent(challenge));
  } catch (err) {
    console.error('Hydra consent error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

// Display info for the dashboard consent screen. Auth-gated; only the user who is
// the consent subject may read it (prevents reading another user's consent).
app.get('/api/v1/oauth/consent/info', authGuard, async (req: Request, res: Response) => {
  const challenge = typeof req.query.consent_challenge === 'string' ? req.query.consent_challenge : '';
  if (!challenge) return res.status(400).json({ error: 'consent_challenge required' });
  try {
    const cr = await getConsentRequest(challenge);
    if (cr.subject !== String(req.userId!)) {
      return res.status(403).json({ error: 'not_your_consent' });
    }
    return res.json({
      clientName: cr.client?.client_name || cr.client?.client_id || 'An application',
      scopes: cr.requested_scope ?? [],
      audience: cr.requested_access_token_audience ?? [],
    });
  } catch (err) {
    console.error('Hydra consent info error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

// User approved the consent screen. Verifies the consent subject is the caller.
app.post('/api/v1/oauth/consent/accept', authGuard, async (req: Request, res: Response) => {
  const { consent_challenge } = req.body ?? {};
  if (typeof consent_challenge !== 'string' || !consent_challenge) {
    return res.status(400).json({ error: 'consent_challenge required' });
  }
  try {
    const cr = await getConsentRequest(consent_challenge);
    if (cr.subject !== String(req.userId!)) {
      return res.status(403).json({ error: 'not_your_consent' });
    }
    if (!(await subjectHasMcpAccess(cr.subject))) {
      return res.status(403).json({ error: 'early_access_required' });
    }
    return res.json({ redirect_to: await grantConsent(consent_challenge) });
  } catch (err) {
    console.error('Hydra consent accept error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

// User denied the consent screen.
app.post('/api/v1/oauth/consent/reject', authGuard, async (req: Request, res: Response) => {
  const { consent_challenge } = req.body ?? {};
  if (typeof consent_challenge !== 'string' || !consent_challenge) {
    return res.status(400).json({ error: 'consent_challenge required' });
  }
  try {
    const cr = await getConsentRequest(consent_challenge);
    if (cr.subject !== String(req.userId!)) {
      return res.status(403).json({ error: 'not_your_consent' });
    }
    const { redirect_to } = await rejectConsent(consent_challenge, 'access_denied');
    return res.json({ redirect_to });
  } catch (err) {
    console.error('Hydra consent reject error:', err instanceof Error ? err.message : err);
    return res.status(502).json({ error: 'hydra_unreachable' });
  }
});

const PAYMENT_RELAYER_URL = process.env.PAYMENT_RELAYER_URL || 'http://payment-relayer:8084';

// Best-effort: mirror the publisher's payout/price onto the paywall contract so
// distribute() can pay them. Never throws into the request path; idempotent.
async function syncCreatorOnChain(user: {
  domain: string | null; siteId?: string | null; domainVerified?: boolean | null;
  stellar_address: string | null; pricePerRequest: unknown; platformFee?: unknown;
}): Promise<void> {
  if (!user.domain || !user.domainVerified || !user.stellar_address) return;
  const price = Number(user.pricePerRequest);
  const platformFee = Number(user.platformFee ?? 0.001);
  if (!(price > 0)) return;
  // Register against the stable tenant key (domain → siteId fallback) so the
  // on-chain creator record survives domain changes / re-keying.
  const key = onchainKey({ domain: user.domain, siteId: user.siteId });
  try {
    const r = await fetch(`${PAYMENT_RELAYER_URL}/register-creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
      body: JSON.stringify({ domain: key, creator: user.stellar_address, price, platformFee }),
    });
    if (!r.ok) console.warn(`[register-creator] relayer ${r.status} for key=${key}`);
  } catch (e) {
    console.warn(`[register-creator] failed for key=${key}:`, (e as Error).message);
  }
}

type TrustlineResp = {
  funded: boolean; hasTrustline: boolean; usdcBalance: string; xlmBalance: string;
  asset: { code: string; issuer: string }; network: string; networkPassphrase: string; horizonUrl: string;
};

// Payout readiness: does the creator's wallet hold a USDC trustline yet?
// Proxies the on-chain check to payment-relayer — auth-service never touches Horizon.
// Returns the asset + network config the frontend needs to build the changeTrust.
app.get('/api/v1/auth/payout-status', authGuard, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stellar_address) {
    // Wallet not set yet (onboarding incomplete) — nothing to check on-chain.
    return res.json({ ready: false, address: null, needsOnboarding: true });
  }
  try {
    const r = await fetch(`${PAYMENT_RELAYER_URL}/trustline?account=${encodeURIComponent(user.stellar_address)}`, {
      headers: { 'X-Internal-Token': INTERNAL_TOKEN },
    });
    if (!r.ok) return res.status(502).json({ error: 'relayer_unreachable' });
    const data = (await r.json()) as TrustlineResp;
    res.json({ ready: data.hasTrustline === true, address: user.stellar_address, ...data });
  } catch {
    res.status(502).json({ error: 'relayer_unreachable' });
  }
});

app.patch('/api/v1/auth/settings', authGuard, async (req: Request, res: Response) => {
  const { pricePerRequest, domain, stellar_address, paywallEnabled } = req.body ?? {};
  const data: {
    pricePerRequest?: number; domain?: string; stellar_address?: string; paywallEnabled?: boolean;
    domainVerified?: boolean; wpInternalToken?: null;
  } = {};

  if (pricePerRequest !== undefined) {
    const n = Number(pricePerRequest);
    if (!Number.isFinite(n) || n < 0.0001 || n > 1) {
      return res.status(400).json({ error: 'pricePerRequest must be between 0.0001 and 1 USDC' });
    }
    data.pricePerRequest = n;
  }
  if (domain !== undefined) {
    const cleanDomain = normalizeDomain(domain);
    if (!cleanDomain) {
      return res.status(400).json({ error: 'Domain must look like example.com' });
    }
    data.domain = cleanDomain;
  }
  if (stellar_address !== undefined) {
    const cleanStellar = validateStellar(stellar_address);
    if (!cleanStellar) {
      return res.status(400).json({ error: 'Stellar address must be a 56-character key starting with G' });
    }
    data.stellar_address = cleanStellar;
  }
  if (paywallEnabled !== undefined) {
    if (typeof paywallEnabled !== 'boolean') {
      return res.status(400).json({ error: 'paywallEnabled must be true or false' });
    }
    data.paywallEnabled = paywallEnabled;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Fetch current user for cross-field guards (Fix 2 + Fix 3).
  const currentUser = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!currentUser) return res.status(404).json({ error: 'User not found' });

  // Fix 3: price must strictly exceed the effective platform fee to prevent InvalidPrice on-chain.
  if (data.pricePerRequest !== undefined) {
    const effectiveFee = Number(currentUser.platformFee ?? 0.001);
    if (data.pricePerRequest <= effectiveFee) {
      return res.status(400).json({ error: 'price_must_exceed_platform_fee' });
    }
  }

  // Fix 2: changing domain invalidates the existing verification so the provisioning wizard
  // re-runs for the new domain — prevents squatting with a stale domainVerified=true.
  if (data.domain !== undefined && data.domain !== currentUser.domain) {
    data.domainVerified = false;
    data.wpInternalToken = null;
  }

  try {
    const user = await prisma.user.update({ where: { id: req.userId! }, data });
    void syncCreatorOnChain(user);
    res.json({ user: shapeUser(user) });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'That domain is already taken by another creator' });
    }
    console.error('Settings update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Humanity challenge / verification ---

app.post('/api/v1/auth/challenge', async (req: Request, res: Response) => {
  const { domain, slug } = req.body ?? {};
  const cleanDomain = normalizeDomain(domain);
  const cleanSlug = validateSlug(slug);
  if (!cleanDomain || !cleanSlug) {
    return res.status(400).json({ error: 'domain and slug required' });
  }

  const ip = reqIp(req);
  if (!rateLimit(ip + ':challenge', 10, 60_000)) {
    return res.status(429).json({ error: 'too_many_challenges' });
  }
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  const ja4 = clientJa4(req);
  const salt = crypto.randomBytes(16).toString('hex');

  const rep = await repLookup({ ja4: ja4 || null, ip, ua });
  const difficulty = adaptDifficulty(POW_DIFFICULTY, rep.tier);

  const challenge = signChallenge({
    domain: cleanDomain,
    slug: cleanSlug,
    salt,
    difficulty,
    ip,
    ua,
    ja4,
    tier: rep.tier,
  });

  res.json({
    challenge,
    salt,
    difficulty,
    ttlSeconds: CHALLENGE_TTL_SEC,
    powSalt: POW_SALT,
  });
});

app.post('/api/v1/auth/verify-human', async (req: Request, res: Response) => {
  const { challenge, nonce, fingerprint, powDurationMs } = req.body ?? {};
  if (typeof challenge !== 'string' || typeof nonce !== 'string') {
    return res.status(400).json({ error: 'challenge and nonce required' });
  }

  let claims: ChallengeClaims;
  try {
    claims = verifyChallenge(challenge);
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_challenge' });
  }

  const ip = reqIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);

  if (claims.ip !== ip || claims.ua !== ua) {
    return res.status(401).json({ error: 'context_mismatch' });
  }

  if (!checkPow(challenge, claims.salt, nonce, claims.difficulty)) {
    return res.status(401).json({ error: 'pow_invalid' });
  }

  // Sanitize powDurationMs (range 0..120_000 ms; anything else is rejected as noise).
  const powMs =
    typeof powDurationMs === 'number' && Number.isFinite(powDurationMs) && powDurationMs >= 0 && powDurationMs <= 120_000
      ? Math.round(powDurationMs)
      : null;
  const powAnomaly = powMs !== null && powMs < POW_MIN_SOLVE_MS;
  if (powAnomaly) {
    console.warn(
      `[ANOMALY] PoW solved in ${powMs}ms (threshold: ${POW_MIN_SOLVE_MS}ms) domain=${claims.domain} slug=${claims.slug} ip=${ip}`,
    );
  }

  const ja4 = claims.ja4 || clientJa4(req) || null;
  const repKey = { ja4, ip, ua };

  // PoW solved suspiciously fast — treat as bot, do NOT issue session
  if (powAnomaly) {
    void repUpdate(repKey, { outcome: 'bot', powDurationMs: powMs, anomaly: true });
    void prisma.user
      .findFirst({ where: { domain: claims.domain }, select: { id: true } })
      .then((u: { id: number } | null) => {
        if (u) {
          return prisma.event.create({
            data: { userId: u.id, type: 'pow_speed_anomaly', sessionId: claims.salt, ip, powDurationMs: powMs, ja4 },
          });
        }
      })
      .catch(() => {});
    return res.status(401).json({ error: 'pow_too_fast' });
  }

  const fpReason = fingerprintReason(fingerprint as Fingerprint);
  if (fpReason) {
    void repUpdate(repKey, { outcome: 'bot', powDurationMs: powMs, anomaly: true });
    void prisma.user
      .findFirst({ where: { domain: claims.domain }, select: { id: true } })
      .then((u: { id: number } | null) => {
        if (u) {
          return prisma.event.create({
            data: {
              userId: u.id,
              type: 'challenge_failed',
              sessionId: claims.salt,
              ip,
              agent: fpReason,
              powDurationMs: powMs,
              ja4,
            },
          });
        }
      })
      .catch(() => {});
    return res.status(401).json({ error: fpReason });
  }

  const sessionToken = signHumanSession({
    domain: claims.domain,
    ip,
    ua,
  });

  void repUpdate(repKey, { outcome: 'human', powDurationMs: powMs, anomaly: false });

  const user = await prisma.user.findFirst({ where: { domain: claims.domain }, select: { id: true } });
  if (user) {
    void prisma.event
      .create({
        data: {
          userId: user.id,
          type: 'challenge_passed',
          sessionId: claims.salt,
          ip,
          agent: powAnomaly ? 'pow_speed_anomaly' : null,
          powDurationMs: powMs,
          ja4,
        },
      })
      .catch(() => {});
  }

  res.json({ sessionToken, ttlSeconds: HUMAN_SESSION_TTL_SEC });
});

// --- Internal lookup + events ---

app.post('/api/v1/auth/events', internalGuard, async (req: Request, res: Response) => {
  const {
    siteId, domain, type, agent, category, amountUsdc, sessionId, txHash, ip, powDurationMs, ja4,
    distributeTransaction, creatorAmountUsdc, platformAmountUsdc, network, asset, payer, status,
  } = req.body ?? {};
  const reqSiteId = typeof siteId === 'string' && siteId.length > 0 ? siteId : undefined;
  const reqDomain = typeof domain === 'string' && domain.length > 0 ? domain : undefined;
  // Task 64: resolve the tenant by siteId (primary — token-only sites may have no
  // domain) and fall back to domain for legacy sites. Either key must be present.
  if ((!reqSiteId && !reqDomain) || !type) {
    return res.status(400).json({ error: 'siteId or domain, and type, required' });
  }

  const user = reqSiteId
    ? await prisma.user.findFirst({ where: { siteId: reqSiteId } })
    : await prisma.user.findFirst({ where: { domain: reqDomain } });
  if (!user) return res.status(404).json({ error: 'No creator registered for this site' });

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 256) : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const event = await prisma.event.create({
    data: {
      userId: user.id,
      // Persist the stable tenant key: the payload's siteId, else the resolved
      // user's siteId (so legacy domain-only emitters still tag the row).
      siteId: reqSiteId ?? user.siteId ?? null,
      type,
      agent: agent ?? null,
      category: category ?? null,
      amountUsdc: typeof amountUsdc === 'number' ? amountUsdc : 0,
      sessionId: sessionId ?? null,
      txHash: txHash ?? null,
      distributeTransaction: str(distributeTransaction),
      creatorAmountUsdc: num(creatorAmountUsdc),
      platformAmountUsdc: num(platformAmountUsdc),
      network: str(network),
      asset: str(asset),
      payer: str(payer),
      status: str(status),
      ip: ip ?? null,
      powDurationMs:
        typeof powDurationMs === 'number' && Number.isFinite(powDurationMs) && powDurationMs >= 0 && powDurationMs <= 120_000
          ? Math.round(powDurationMs)
          : null,
      ja4: typeof ja4 === 'string' && ja4.length > 0 ? ja4.slice(0, 256) : null,
    },
  });
  res.status(201).json({ status: 'success', eventId: event.id });
});

const PLATFORM_STELLAR_ADDRESS = requireEnv('PLATFORM_STELLAR_ADDRESS');

app.get('/api/v1/auth/lookup', internalGuard, async (req: Request, res: Response) => {
  // Resolve a tenant by site token (primary, Task 55) or by domain (legacy).
  const token = req.query.token as string | undefined;
  const domain = req.query.domain as string | undefined;
  if (!token && !domain) return res.status(400).json({ error: 'token or domain required' });
  const select = {
    domain: true,
    siteId: true,
    stellar_address: true,
    pricePerRequest: true,
    platformFee: true,
    paywallEnabled: true,
    wpInternalToken: true,
    contentUrl: true,
  } as const;
  const user = token
    ? await prisma.user.findFirst({ where: { wpInternalToken: token }, select })
    : await prisma.user.findFirst({ where: { domain }, select });
  if (!user) return res.status(404).json({ error: 'Not found' });
  // Stable tenant key (domain → siteId fallback). Guard against the impossible
  // both-empty case so a malformed row degrades to onchainKey:null, not a 500.
  const hasKey = !!(user.domain ?? '').trim() || !!(user.siteId ?? '').trim();
  res.json({
    domain: user.domain,
    siteId: user.siteId ?? null,
    stellar_address: user.stellar_address,
    pricePerRequest: Number(user.pricePerRequest),
    platformFee: Number(user.platformFee || 0),
    platform_address: PLATFORM_STELLAR_ADDRESS,
    paywallEnabled: user.paywallEnabled,
    wpInternalToken: user.wpInternalToken ?? null,
    contentUrl: user.contentUrl ?? null,
    onchainKey: hasKey ? onchainKey({ domain: user.domain, siteId: user.siteId }) : null,
  });
});

// --- Zero-config "Connect to Verivyx" handshake (init → authorize → token) ---
// OAuth-authorization-code style: the secret token is returned only at the
// server-to-server `token` exchange (one-time code). Ownership is proven by an
// SSRF-guarded callback to the real domain, gated by a per-handshake nonce.

app.post('/api/v1/domains/connect/init', async (req: Request, res: Response) => {
  const site = String(req.body?.site ?? '').trim().toLowerCase();
  if (!isValidPublicHost(site)) return res.status(400).json({ error: 'invalid_site' });
  const connectId = newConnectId();
  const nonce = newNonce();
  await prisma.connectPending.create({ data: { connectId, site, nonce } });
  return res.json({ connect_id: connectId, nonce });
});

app.post('/api/v1/domains/connect/authorize', authGuard, async (req: AuthedRequest, res: Response) => {
  const connectId = String(req.body?.connect_id ?? '');
  const pending = await prisma.connectPending.findUnique({ where: { connectId } });
  if (!pending) return res.status(404).json({ error: 'unknown_connect' });
  if (isPendingExpired(pending.createdAt)) {
    await prisma.connectPending.delete({ where: { connectId } }).catch(() => {});
    return res.status(410).json({ error: 'expired' });
  }
  let confirmedNonce: string;
  try {
    confirmedNonce = await confirmOwnership(pending.site, connectId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'confirm_failed';
    return res.status(msg === 'invalid_site' ? 400 : 502).json({ error: msg });
  }
  if (confirmedNonce !== pending.nonce) return res.status(502).json({ error: 'confirm_failed' });

  const userId = req.userId!;
  const conflict = await prisma.user.findFirst({ where: { domain: pending.site, NOT: { id: userId } } });
  if (conflict) return res.status(409).json({ error: 'domain_conflict' });
  await prisma.user.update({ where: { id: userId }, data: { domain: pending.site } });

  const code = newCode();
  await prisma.connectPending.update({ where: { connectId }, data: { code, codeUsed: false, userId } });
  return res.json({ code });
});

app.post('/api/v1/domains/connect/token', async (req: Request, res: Response) => {
  const connectId = String(req.body?.connect_id ?? '');
  const code = String(req.body?.code ?? '');
  if (!connectId || !code) return res.status(400).json({ error: 'invalid_request' });
  const pending = await prisma.connectPending.findUnique({ where: { connectId } });
  if (!pending || !pending.code || pending.userId == null) return res.status(404).json({ error: 'unknown_connect' });
  if (pending.codeUsed) return res.status(409).json({ error: 'code_used' });
  if (isPendingExpired(pending.createdAt)) return res.status(410).json({ error: 'expired' });
  const a = Buffer.from(code);
  const b = Buffer.from(pending.code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'bad_code' });
  }
  const token = crypto.randomBytes(30).toString('base64url'); // 40-char url-safe secret
  await prisma.user.update({
    where: { id: pending.userId },
    data: { wpInternalToken: token, domainVerified: true, domainVerifiedAt: new Date() },
  });
  await prisma.connectPending.delete({ where: { connectId } }).catch(() => {});
  return res.json({ token });
});

// --- Internal content fetch (used by hydration service) ---

app.get('/api/v1/auth/content/get', internalGuard, async (req: Request, res: Response) => {
  const domain = req.query.domain as string | undefined;
  const slug = req.query.slug as string | undefined;
  if (!domain || !slug) return res.status(400).json({ error: 'domain and slug required' });
  const user = await prisma.user.findFirst({ where: { domain }, select: { id: true } });
  if (!user) return res.status(404).json({ error: 'creator_not_found' });
  const content = await prisma.content.findFirst({ where: { userId: user.id, slug } });
  if (!content) return res.status(404).json({ error: 'content_not_found' });
  res.json({
    slug: content.slug,
    title: content.title,
    body: content.body,
    mimeType: content.mimeType,
  });
});

// --- Creator content CRUD ---

app.get('/api/v1/auth/contents', authGuard, async (req: Request, res: Response) => {
  const list = await prisma.content.findMany({
    where: { userId: req.userId! },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, slug: true, title: true, mimeType: true, updatedAt: true },
  });
  res.json({ contents: list });
});

app.get('/api/v1/auth/contents/:slug', authGuard, async (req: Request, res: Response) => {
  const slug = validateSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'invalid slug' });
  const content = await prisma.content.findFirst({ where: { userId: req.userId!, slug } });
  if (!content) return res.status(404).json({ error: 'not_found' });
  res.json({
    content: {
      id: content.id,
      slug: content.slug,
      title: content.title,
      body: content.body,
      mimeType: content.mimeType,
      updatedAt: content.updatedAt,
    },
  });
});

app.post('/api/v1/auth/contents', authGuard, async (req: Request, res: Response) => {
  const { slug, title, body, mimeType } = req.body ?? {};
  const cleanSlug = validateSlug(slug);
  if (!cleanSlug) return res.status(400).json({ error: 'slug must be lowercase alphanumeric/hyphen' });
  if (typeof body !== 'string' || body.length === 0) return res.status(400).json({ error: 'body required' });
  if (body.length > 200_000) return res.status(400).json({ error: 'body too large (200KB max)' });
  const mt = typeof mimeType === 'string' && mimeType.length < 64 ? mimeType : 'text/html';
  try {
    const content = await prisma.content.create({
      data: {
        userId: req.userId!,
        slug: cleanSlug,
        title: typeof title === 'string' ? title.slice(0, 256) : null,
        body,
        mimeType: mt,
      },
    });
    res.status(201).json({ content });
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Slug already exists' });
    console.error('content create:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/v1/auth/contents/:slug', authGuard, async (req: Request, res: Response) => {
  const slug = validateSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'invalid slug' });
  const { title, body, mimeType } = req.body ?? {};
  const data: { title?: string; body?: string; mimeType?: string } = {};
  if (typeof title === 'string') data.title = title.slice(0, 256);
  if (typeof body === 'string') {
    if (body.length === 0 || body.length > 200_000) return res.status(400).json({ error: 'body invalid size' });
    data.body = body;
  }
  if (typeof mimeType === 'string' && mimeType.length < 64) data.mimeType = mimeType;
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const existing = await prisma.content.findFirst({ where: { userId: req.userId!, slug } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const content = await prisma.content.update({ where: { id: existing.id }, data });
  res.json({ content });
});

app.delete('/api/v1/auth/contents/:slug', authGuard, async (req: Request, res: Response) => {
  const slug = validateSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'invalid slug' });
  const existing = await prisma.content.findFirst({ where: { userId: req.userId!, slug } });
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await prisma.content.delete({ where: { id: existing.id } });
  res.json({ status: 'deleted' });
});

// --- Analytics ---

// Shared shape for a settled-payment / activity event, including on-chain proof.
type TxEventRow = {
  id: number; type: string; agent: string | null; category: string | null;
  amountUsdc: Prisma.Decimal; createdAt: Date; sessionId: string | null;
  txHash: string | null; distributeTransaction: string | null;
  creatorAmountUsdc: Prisma.Decimal | null; platformAmountUsdc: Prisma.Decimal | null;
  network: string | null; asset: string | null; payer: string | null; status: string | null;
  ip: string | null; powDurationMs: number | null; ja4: string | null;
};

function shapeTxEvent(e: TxEventRow) {
  return {
    id: e.id, type: e.type, agent: e.agent, category: e.category,
    amountUsdc: Number(e.amountUsdc), createdAt: e.createdAt, sessionId: e.sessionId,
    txHash: e.txHash, distributeTransaction: e.distributeTransaction,
    creatorAmountUsdc: e.creatorAmountUsdc != null ? Number(e.creatorAmountUsdc) : null,
    platformAmountUsdc: e.platformAmountUsdc != null ? Number(e.platformAmountUsdc) : null,
    network: e.network, asset: e.asset, payer: e.payer, status: e.status,
    ip: e.ip, powDurationMs: e.powDurationMs, ja4: e.ja4,
  };
}

app.get('/api/v1/auth/analytics', authGuard, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sincePrev = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [totals, prevTotals, byAgent, recent, signalRows, anomalyCount, topJa4] = await Promise.all([
    prisma.event.groupBy({
      by: ['type'],
      where: { userId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amountUsdc: true },
    }),
    prisma.event.groupBy({
      by: ['type'],
      where: { userId, createdAt: { gte: sincePrev, lt: since } },
      _count: { _all: true },
      _sum: { amountUsdc: true },
    }),
    prisma.event.groupBy({
      by: ['agent', 'category'],
      where: { userId, agent: { not: null } },
      _count: { _all: true },
      _sum: { amountUsdc: true },
    }),
    prisma.event.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 12 }),
    // Pull only solve-time samples in the 7-day window so the bucket histogram
    // reflects current behaviour, not all-time noise.
    prisma.event.findMany({
      where: { userId, createdAt: { gte: since }, powDurationMs: { not: null } },
      select: { powDurationMs: true },
      take: 5000,
    }),
    prisma.event.count({ where: { userId, createdAt: { gte: since }, agent: 'pow_speed_anomaly' } }),
    prisma.event.groupBy({
      by: ['ja4'],
      where: { userId, createdAt: { gte: since }, ja4: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { ja4: 'desc' } },
      take: 5,
    }),
  ]);

  type GroupedTotal = { type: string; _count: { _all: number }; _sum: { amountUsdc: Prisma.Decimal | null } };
  const sumOf = (rows: GroupedTotal[], key: string) => rows.find((r) => r.type === key)?._count._all ?? 0;
  const earnedNow = (totals as GroupedTotal[]).reduce((a, b) => a + Number(b._sum.amountUsdc ?? 0), 0);
  const earnedPrev = (prevTotals as GroupedTotal[]).reduce((a, b) => a + Number(b._sum.amountUsdc ?? 0), 0);
  const earnedDelta = earnedPrev > 0 ? ((earnedNow - earnedPrev) / earnedPrev) * 100 : 0;

  const botsBlocked = sumOf(totals as GroupedTotal[], 'bot_blocked');
  const humansServed = sumOf(totals as GroupedTotal[], 'challenge_passed');
  const humansFailed = sumOf(totals as GroupedTotal[], 'challenge_failed');
  const paymentsVerified = sumOf(totals as GroupedTotal[], 'payment_verified');

  const totalAgents = botsBlocked + paymentsVerified;
  const ratio =
    humansServed === 0 && totalAgents === 0
      ? '0 : 0'
      : humansServed === 0
      ? `0 : ${totalAgents}`
      : `1 : ${Math.max(1, Math.round(totalAgents / Math.max(humansServed, 1)))}`;

  // Bucket PoW solve times. Buckets are picked to match the assumptions in
  // TECHNICAL.md: humans 100–200ms, fast bots <50ms, slow devices >500ms.
  const buckets = { under50: 0, between50_200: 0, between200_500: 0, over500: 0 };
  for (const row of signalRows as Array<{ powDurationMs: number | null }>) {
    const v = row.powDurationMs;
    if (typeof v !== 'number') continue;
    if (v < 50) buckets.under50++;
    else if (v < 200) buckets.between50_200++;
    else if (v < 500) buckets.between200_500++;
    else buckets.over500++;
  }

  res.json({
    totals: {
      earnedUsdc: Number(earnedNow.toFixed(4)),
      earnedDeltaPct: Number(earnedDelta.toFixed(1)),
      botsBlocked,
      humansServed,
      humansFailed,
      paymentsVerified,
      humanBotRatio: ratio,
      powAnomalies7d: anomalyCount,
    },
    powDurationBuckets: buckets,
    topJa4: (topJa4 as Array<{ ja4: string | null; _count: { _all: number } }>)
      .filter((row) => row.ja4)
      .map((row) => ({ ja4: row.ja4 as string, count: row._count._all })),
    agents: byAgent.map(
      (row: { agent: string | null; category: string | null; _count: { _all: number }; _sum: { amountUsdc: Prisma.Decimal | null } }) => ({
        agent: row.agent,
        category: row.category,
        intercepts: row._count._all,
        revenue: Number((row._sum.amountUsdc ?? 0)),
      }),
    ),
    recent: recent.map(shapeTxEvent),
  });
});

// Paginated list of a creator's own settled payments — full on-chain proof.
app.get('/api/v1/auth/transactions', authGuard, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = Number(req.query.cursor) || undefined; // last seen event id
  const rows = await prisma.event.findMany({
    where: { userId, type: 'payment_verified' },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    transactions: page.map(shapeTxEvent),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
});

// --- SDK domain provisioning (DNS TXT handshake) ---
//
// Non-WordPress publishers prove domain ownership by adding a DNS TXT record
// `verivyx-site-verification=<nonce>` to the domain apex. Flow:
//   1. POST /api/v1/sdk/provision/init   → { nonce }  (store nonce, TTL 60 min)
//   2. Publisher adds a DNS TXT record `verivyx-site-verification=<nonce>` to the domain apex.
//   3. POST /api/v1/sdk/provision/verify { site, nonce }
//                                        → { token }  (DNS TXT lookup+verify,
//                                                       then issues per-domain token)
// Reuses the same wpInternalToken column as the WP Connect handshake.

const PROVISION_TTL_MS = 60 * 60_000;

interface ProvisionPending {
  nonce: string;
  createdAt: number;
}

// In-memory store: nonce → pending. Map is keyed by nonce so the verify step
// can look up by the nonce the client submits.
const _provisionPending = new Map<string, ProvisionPending>();

function pruneProvisionPending(): void {
  const now = Date.now();
  for (const [key, val] of _provisionPending) {
    if (now - val.createdAt > PROVISION_TTL_MS) _provisionPending.delete(key);
  }
}

// GET /api/v1/sdk/site
// Auth-guarded. Returns the caller's stable siteId and site token (the SDK's
// VERIVYX_TOKEN). Both are issued at signup, so the dashboard/SDK wizard can
// surface them without any DNS provisioning step.
app.get('/api/v1/sdk/site', authGuard, async (req: AuthedRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { siteId: true, wpInternalToken: true },
  });
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  return res.json({ siteId: user.siteId ?? null, token: user.wpInternalToken ?? null });
});

// POST /api/v1/sdk/provision/init
// Auth-guarded. Issues a nonce the publisher must add as a DNS TXT record `verivyx-site-verification=<nonce>` to the domain apex.
app.post('/api/v1/sdk/provision/init', authGuard, (req: AuthedRequest, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(`sdkinit:${ip}`, 10, 60 * 60_000)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  pruneProvisionPending();
  const nonce = newNonce();
  _provisionPending.set(nonce, { nonce, createdAt: Date.now() });
  return res.json({ nonce });
});

// POST /api/v1/sdk/provision/verify
// Auth-guarded. Verifies the nonce is present as a DNS TXT record on the apex domain then
// issues (or reissues) the per-domain token on the authenticated user account.
app.post('/api/v1/sdk/provision/verify', authGuard, async (req: AuthedRequest, res: Response) => {
  const ip = reqIp(req);
  if (!rateLimit(`sdkverify:${ip}`, 10, 60 * 60_000)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  const site = String(req.body?.site ?? '').trim().toLowerCase();
  const nonce = String(req.body?.nonce ?? '').trim();
  if (!site || !nonce) return res.status(400).json({ error: 'site and nonce are required' });

  pruneProvisionPending();
  const pending = _provisionPending.get(nonce);
  if (!pending) return res.status(404).json({ error: 'unknown_nonce' });
  if (Date.now() - pending.createdAt > PROVISION_TTL_MS) {
    _provisionPending.delete(nonce);
    return res.status(410).json({ error: 'expired' });
  }

  let verified: boolean;
  try {
    verified = await verifyDomainTxt(site, nonce);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'verify_failed';
    return res.status(msg === 'invalid_site' ? 400 : 502).json({ error: msg });
  }
  if (!verified) return res.status(502).json({ error: 'verify_failed' });

  // Nonce consumed — remove from pending store (one-shot).
  _provisionPending.delete(nonce);

  const userId = req.userId!;
  const conflict = await prisma.user.findFirst({ where: { domain: site, NOT: { id: userId } } });
  if (conflict) return res.status(409).json({ error: 'domain_conflict' });

  const token = crypto.randomBytes(30).toString('base64url');
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { domain: site, wpInternalToken: token, domainVerified: true, domainVerifiedAt: new Date() },
  });
  void syncCreatorOnChain(updatedUser);
  return res.json({ token });
});

// domainTokenGuard reads Authorization: Bearer <per-domain-token>, looks up the
// User by that token, and attaches userId + userEmail + domain to the request.
// Rejects with 401 if the token is missing, empty, unknown, or belongs to an
// unverified domain.
async function domainTokenGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  const token = header.slice(7);
  if (!token) { res.status(401).json({ error: 'Missing token' }); return; }
  const user = await prisma.user.findFirst({
    where: { wpInternalToken: token, domainVerified: true },
    select: { id: true, email: true, domain: true },
  });
  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  req.userId = user.id;
  req.userEmail = user.email;
  req.domain = user.domain ?? undefined;
  next();
}

// ──────────────── ADMIN ROUTES ────────────────

app.get('/api/v1/admin/stats', adminGuard, async (req: AuthedRequest, res: Response) => {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [
    creatorCount,
    activeCreators7d,
    newCreators7d,
    gmvAll,
    gmv7d,
    traffic7d,
    topAgents,
    powAnomalies7d,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { events: { some: { createdAt: { gte: since7d } } } } }),
    prisma.user.count({ where: { createdAt: { gte: since7d } } }),
    prisma.event.aggregate({ where: { type: 'payment_verified' }, _sum: { amountUsdc: true } }),
    prisma.event.aggregate({ where: { type: 'payment_verified', createdAt: { gte: since7d } }, _sum: { amountUsdc: true } }),
    prisma.event.groupBy({
      by: ['type'],
      where: { createdAt: { gte: since7d } },
      _count: { _all: true },
    }),
    prisma.event.groupBy({
      by: ['agent', 'category'],
      where: { agent: { not: null } },
      _count: { _all: true },
      _sum: { amountUsdc: true },
      orderBy: { _sum: { amountUsdc: 'desc' } },
      take: 8,
    }),
    prisma.event.count({ where: { createdAt: { gte: since7d }, agent: 'pow_speed_anomaly' } }),
  ]);

  // Platform profit via raw query (accurate: per-creator fee * their GMV)
  const profitAll = await prisma.$queryRaw<[{ profit: number }]>`
    SELECT COALESCE(SUM(e."amountUsdc" * COALESCE(u."platformFee", 0.001)), 0)::float AS profit
    FROM "Event" e JOIN "User" u ON e."userId" = u."id"
    WHERE e."type" = 'payment_verified'
  `;
  const profit7d = await prisma.$queryRaw<[{ profit: number }]>`
    SELECT COALESCE(SUM(e."amountUsdc" * COALESCE(u."platformFee", 0.001)), 0)::float AS profit
    FROM "Event" e JOIN "User" u ON e."userId" = u."id"
    WHERE e."type" = 'payment_verified' AND e."createdAt" >= ${since7d}
  `;

  type TG = { type: string; _count: { _all: number } };
  const sumOf = (key: string) => (traffic7d as TG[]).find(r => r.type === key)?._count._all ?? 0;

  res.json({
    financial: {
      gmvAllTime: Number((gmvAll._sum.amountUsdc ?? 0).toFixed(6)),
      gmv7d: Number((gmv7d._sum.amountUsdc ?? 0).toFixed(6)),
      platformProfitAllTime: Number((profitAll[0]?.profit ?? 0).toFixed(6)),
      platformProfit7d: Number((profit7d[0]?.profit ?? 0).toFixed(6)),
    },
    ecosystem: { totalCreators: creatorCount, activeCreators7d, newCreators7d },
    traffic: {
      paymentsVerified7d: sumOf('payment_verified'),
      botsBlocked7d: sumOf('bot_blocked'),
      humansServed7d: sumOf('challenge_passed'),
      powAnomalies7d,
    },
    topAgents: topAgents.map(r => ({
      agent: r.agent,
      category: r.category,
      intercepts: r._count._all,
      revenue: Number((r._sum.amountUsdc ?? 0).toFixed(4)),
    })),
  });
});

app.get('/api/v1/admin/creators', adminGuard, async (_req: AuthedRequest, res: Response) => {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const creators = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, email: true, domain: true, stellar_address: true,
      emailVerified: true, domainVerified: true, pricePerRequest: true, platformFee: true, apiKey: true,
      paywallEnabled: true, mcpEarlyAccess: true, createdAt: true, role: true,
      events: {
        where: { createdAt: { gte: since7d } },
        select: { type: true, amountUsdc: true },
      },
    },
  });

  const result = creators.map(c => {
    const fee = c.platformFee != null ? Number(c.platformFee) : 0.001;
    const payments = c.events.filter(e => e.type === 'payment_verified');
    const gmv7d = payments.reduce((s, e) => s + Number(e.amountUsdc), 0);
    return {
      ...shapeUser(c),
      payments7d: payments.length,
      botsBlocked7d: c.events.filter(e => e.type === 'bot_blocked').length,
      gmv7d: Number(gmv7d.toFixed(6)),
      platformFee7d: Number((gmv7d * fee).toFixed(6)),
    };
  });

  res.json({ creators: result });
});

app.patch('/api/v1/admin/creators/:id', adminGuard, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { platformFee, paywallEnabled } = req.body ?? {};
  const update: { platformFee?: number; paywallEnabled?: boolean } = {};

  if (platformFee !== undefined) {
    const n = Number(platformFee);
    if (!Number.isFinite(n) || n < 0 || n > 1) return res.status(400).json({ error: 'platformFee must be 0–1' });
    update.platformFee = n;
  }
  if (paywallEnabled !== undefined) {
    if (typeof paywallEnabled !== 'boolean') return res.status(400).json({ error: 'paywallEnabled must be boolean' });
    update.paywallEnabled = paywallEnabled;
  }
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, domain: true } });
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'ADMIN' && update.platformFee !== undefined) {
    return res.status(400).json({ error: 'Cannot change platform fee for admin users' });
  }

  const updated = await prisma.user.update({ where: { id }, data: update as Prisma.UserUpdateInput });
  await logAdminAction(req.userId!, 'UPDATE_CREATOR', `user:${id}:${target.domain}`, update);
  res.json({ creator: shapeUser(updated) });
});

// Delete a creator account (cascades Events/Contents via the schema relations).
// Admin users cannot be deleted, to avoid locking out the platform.
app.delete('/api/v1/admin/creators/:id', adminGuard, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, domain: true, email: true } });
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'ADMIN') {
    return res.status(400).json({ error: 'Cannot delete an admin account' });
  }

  await prisma.user.delete({ where: { id } });
  await logAdminAction(req.userId!, 'DELETE_CREATOR', `user:${id}:${target.domain ?? target.email}`, { email: target.email });
  res.json({ status: 'success', deletedId: id });
});

app.get('/api/v1/admin/logs', adminGuard, async (_req: AuthedRequest, res: Response) => {
  const logs = await prisma.adminLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { admin: { select: { email: true } } },
  });
  res.json({
    logs: logs.map(l => ({
      id: l.id,
      adminEmail: l.admin.email,
      action: l.action,
      target: l.target,
      metadata: l.metadata,
      createdAt: l.createdAt,
    })),
  });
});

// Global, cross-creator settled-payment ledger with on-chain proof.
// Optional filters: ?domain=, ?since=ISO, ?limit=, ?cursor=lastId
app.get('/api/v1/admin/transactions', adminGuard, async (req: AuthedRequest, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = Number(req.query.cursor) || undefined;
  const domain = typeof req.query.domain === 'string' && req.query.domain.length > 0 ? req.query.domain : undefined;
  // Task 64: allow scoping a token-only tenant by its stable siteId. Matches the
  // event's own siteId column (set on ingest) so it works even for rows whose
  // creator has no domain.
  const siteId = typeof req.query.siteId === 'string' && req.query.siteId.length > 0 ? req.query.siteId : undefined;
  const sinceRaw = typeof req.query.since === 'string' ? new Date(req.query.since) : undefined;
  const since = sinceRaw && !Number.isNaN(sinceRaw.getTime()) ? sinceRaw : undefined;

  const where: Prisma.EventWhereInput = {
    type: 'payment_verified',
    ...(since ? { createdAt: { gte: since } } : {}),
    ...(siteId ? { siteId } : {}),
    ...(domain ? { user: { domain } } : {}),
  };

  const rows = await prisma.event.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { domain: true, siteId: true, email: true } } },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    transactions: page.map(e => ({
      ...shapeTxEvent(e),
      siteId: e.siteId ?? e.user.siteId ?? null,
      // Legacy label: domain if present, else the siteId, else the creator email.
      domain: siteLabel({ domain: e.user.domain, siteId: e.siteId ?? e.user.siteId, fallback: e.user.email }),
      creatorEmail: e.user.email,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
});

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://mcp-server:8088';

// Admin: grant or revoke per-user MCP early-access flag (invitation control).
// Body: { userId?: number; email?: string; grant: boolean }
// Resolves the user by userId (preferred) or email. Also syncs McpWaitlist.invited.
app.post('/api/v1/admin/mcp/early-access', adminGuard, async (req: AuthedRequest, res: Response) => {
  const { userId, email, grant } = req.body ?? {};
  if (typeof grant !== 'boolean') {
    return res.status(400).json({ error: '`grant` (boolean) is required' });
  }
  if (userId == null && typeof email !== 'string') {
    return res.status(400).json({ error: 'Provide `userId` or `email`' });
  }

  let user: { id: number; email: string } | null = null;
  try {
    if (userId != null) {
      user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, email: true } });
    } else {
      user = await prisma.user.findUnique({ where: { email: (email as string).trim().toLowerCase() }, select: { id: true, email: true } });
    }
  } catch (err) {
    console.error('mcp/early-access lookup error:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    await prisma.user.update({ where: { id: user.id }, data: { mcpEarlyAccess: grant } });
    // Best-effort: keep McpWaitlist.invited in sync if the user's email appears there.
    await prisma.mcpWaitlist.updateMany({ where: { email: user.email }, data: { invited: grant } }).catch(() => {});
    await logAdminAction(req.userId!, 'mcp_early_access', String(user.id), { grant });
    res.json({ ok: true, userId: user.id, email: user.email, mcpEarlyAccess: grant });
  } catch (err) {
    console.error('mcp/early-access update error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: grant/revoke MCP early-access by email, with pre-grant for emails that
// are not yet registered. When the email belongs to an existing user we flip the
// `mcpEarlyAccess` flag directly; in all grant cases we record an
// McpEarlyAccessGrant row so a future registration with that email is auto-granted
// (see registration handler). Emails are normalised to lowercase on write across
// the codebase, so an exact lowercase lookup is the case-insensitive match.
app.post('/api/v1/admin/mcp/grant', adminGuard, async (req: AuthedRequest, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const granted = req.body?.granted !== false; // default true
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid_email_required' });
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (granted) {
      if (user) await prisma.user.update({ where: { id: user.id }, data: { mcpEarlyAccess: true } });
      await prisma.mcpEarlyAccessGrant.upsert({
        where: { email },
        create: { email, grantedByAdmin: req.userId! },
        update: { grantedByAdmin: req.userId! },
      });
    } else {
      if (user) await prisma.user.update({ where: { id: user.id }, data: { mcpEarlyAccess: false } });
      await prisma.mcpEarlyAccessGrant.deleteMany({ where: { email } });
    }
    // Best-effort: keep the public waitlist's `invited` flag in sync.
    await prisma.mcpWaitlist.updateMany({ where: { email }, data: { invited: granted } }).catch(() => {});
    await logAdminAction(req.userId!, granted ? 'mcp_early_access_grant' : 'mcp_early_access_revoke', email, { granted, userExisted: !!user });
    res.json({ ok: true, email, granted, applied: !!user, preGranted: !user && granted });
  } catch (err) {
    console.error('mcp/grant error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: MCP early-access waitlist. Each row is enriched with whether the email
// belongs to a registered user and that user's current early-access flag.
app.get('/api/v1/admin/mcp-waitlist', adminGuard, async (_req: AuthedRequest, res: Response) => {
  const [rows, total] = await Promise.all([
    prisma.mcpWaitlist.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.mcpWaitlist.count(),
  ]);
  const emails = rows.map((r) => r.email);
  const users = emails.length
    ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true, mcpEarlyAccess: true } })
    : [];
  const byEmail = new Map(users.map((u) => [u.email, u.mcpEarlyAccess]));
  const waitlist = rows.map((r) => ({
    ...r,
    registered: byEmail.has(r.email),
    mcpEarlyAccess: byEmail.get(r.email) ?? false,
  }));
  res.json({ total, waitlist });
});

// Admin: MCP server health/overview (proxied from mcp-server's internal endpoint).
app.get('/api/v1/admin/mcp-overview', adminGuard, async (_req: AuthedRequest, res: Response) => {
  try {
    const r = await fetch(`${MCP_SERVER_URL}/admin/overview`, {
      headers: { 'X-Internal-Token': INTERNAL_TOKEN },
    });
    if (!r.ok) {
      return res.status(502).json({ error: 'mcp_unreachable', status: r.status });
    }
    res.json(await r.json());
  } catch {
    res.status(502).json({ error: 'mcp_unreachable' });
  }
});

// Auto-promote ADMIN_EMAIL to admin role on startup (idempotent)
if (process.env.ADMIN_EMAIL) {
  prisma.user.updateMany({
    where: { email: process.env.ADMIN_EMAIL.trim().toLowerCase() },
    data: { role: 'ADMIN' },
  }).then(r => { if (r.count > 0) console.log(`[admin] Promoted ${process.env.ADMIN_EMAIL} to ADMIN`); }).catch(() => {});
}

if (!process.env.SKIP_LISTEN) {
  const PORT = process.env.PORT || 8083;
  app.listen(PORT, () => {
    console.log(`Auth Service running on port ${PORT} (challenge difficulty=${POW_DIFFICULTY})`);
  });
}

// Exported for tests
export { signCreator, signChallenge, signHumanSession, app, domainTokenGuard };
