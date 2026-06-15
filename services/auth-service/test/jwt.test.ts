// JWT signing tests. Importing index.ts requires a few env vars (it calls
// requireEnv at module load) and SKIP_LISTEN so it does not bind a port.
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_SECRET = 'test-session-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

process.env.SKIP_LISTEN = '1';
process.env.JWT_SECRET = JWT_SECRET;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.INTERNAL_TOKEN = 'test-internal-token';
process.env.POW_SALT = 'test-pow-salt';
process.env.APP_BASE_URL = 'https://verivyx.test';
process.env.PLATFORM_STELLAR_ADDRESS = 'GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X';

let signCreator: (c: { id: number; email: string }) => string;
let signChallenge: (c: Record<string, unknown>) => string;
let signHumanSession: (c: { domain: string; ip: string; ua: string }) => string;

before(async () => {
  const mod = await import('../index.js');
  signCreator = mod.signCreator;
  signChallenge = mod.signChallenge as typeof signChallenge;
  signHumanSession = mod.signHumanSession;
});

test('signCreator issues a 7d creator-audience token verifiable with JWT_SECRET', () => {
  const token = signCreator({ id: 7, email: 'rio@verivyx.test' });
  const decoded = jwt.verify(token, JWT_SECRET, { audience: 'creator' }) as jwt.JwtPayload;
  assert.equal(decoded.id, 7);
  assert.equal(decoded.email, 'rio@verivyx.test');
  assert.equal(decoded.aud, 'creator');
  // 7 days ≈ 604800s
  assert.equal((decoded.exp as number) - (decoded.iat as number), 7 * 24 * 60 * 60);
});

test('creator token is signed with JWT_SECRET, not SESSION_SECRET', () => {
  const token = signCreator({ id: 1, email: 'a@b.c' });
  assert.throws(() => jwt.verify(token, SESSION_SECRET, { audience: 'creator' }));
});

test('challenge and human tokens use SESSION_SECRET with distinct audiences', () => {
  const challenge = signChallenge({
    domain: 'demo.com', slug: 'a', salt: 's', difficulty: 18, ip: '1.1.1.1', ua: 'ua',
  });
  const human = signHumanSession({ domain: 'demo.com', ip: '1.1.1.1', ua: 'ua' });

  const c = jwt.verify(challenge, SESSION_SECRET, { audience: 'challenge' }) as jwt.JwtPayload;
  assert.equal(c.aud, 'challenge');
  assert.equal((c.exp as number) - (c.iat as number), 60); // CHALLENGE_TTL_SEC

  const h = jwt.verify(human, SESSION_SECRET, { audience: 'human' }) as jwt.JwtPayload;
  assert.equal(h.aud, 'human');
  assert.equal((h.exp as number) - (h.iat as number), 30 * 60); // HUMAN_SESSION_TTL_SEC
});

test('audiences are not interchangeable (human token rejected as challenge)', () => {
  const human = signHumanSession({ domain: 'demo.com', ip: '1.1.1.1', ua: 'ua' });
  assert.throws(() => jwt.verify(human, SESSION_SECRET, { audience: 'challenge' }));
});
