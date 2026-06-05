// Multi-signal reputation scoring backed by Redis.
//
// Key:    rep:<ja4|none>:<ipPrefix>:<uaCohort>
// Value:  HASH { humans, bots, anomalies, lastSeen, avgPowMs }
//
// Score is recomputed on demand from humans / bots and clamped to 0..100.
// /challenge maps the score to a tier and adapts POW difficulty.
// /verify-human increments counters based on the outcome.

import { createClient, type RedisClientType } from 'redis';

export type Tier = 'trusted' | 'standard' | 'risky';

export interface RepKey {
  ja4: string | null;
  ip: string;
  ua: string;
}

export interface RepRecord {
  humans: number;
  bots: number;
  anomalies: number;
  lastSeen: number;
  avgPowMs: number;
  score: number;
  tier: Tier;
}

let client: RedisClientType | null = null;
let connecting: Promise<void> | null = null;

function redisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const addr = process.env.REDIS_ADDR || 'redis:6379';
  const pass = process.env.REDIS_PASSWORD;
  return pass ? `redis://:${encodeURIComponent(pass)}@${addr}` : `redis://${addr}`;
}

async function getClient(): Promise<RedisClientType | null> {
  if (client?.isReady) return client;
  if (!connecting) {
    const c = createClient({ url: redisUrl(), socket: { reconnectStrategy: (n: number) => Math.min(n * 200, 5_000) } });
    c.on('error', (err: Error) => console.warn('[reputation] redis error:', err.message));
    connecting = c
      .connect()
      .then(() => {
        client = c as RedisClientType;
      })
      .catch((err: Error) => {
        console.warn('[reputation] redis connect failed:', err.message);
        connecting = null;
      });
  }
  await connecting;
  return client && client.isReady ? client : null;
}

// Cohort buckets — coarse on purpose. Real browsers fall into one of these,
// most bot stacks (curl/python-requests/aiohttp/Go net/http) land in "other".
function uaCohort(ua: string): string {
  const s = (ua || '').toLowerCase();
  if (s.includes('edg/')) return 'edge';
  if (s.includes('firefox/')) return 'firefox';
  if (s.includes('chrome/')) return 'chrome';
  if (s.includes('safari/')) return 'safari';
  return 'other';
}

// IPv4 → /16 ("1.2"). IPv6 → first 4 hextets. Falls back to "unknown".
function ipPrefix(ip: string): string {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean).slice(0, 4);
    return parts.join(':') || 'unknown';
  }
  const parts = ip.split('.');
  if (parts.length < 2) return 'unknown';
  return `${parts[0]}.${parts[1]}`;
}

export function repKeyOf(k: RepKey): string {
  const ja4 = k.ja4 && k.ja4.length > 0 ? k.ja4 : 'none';
  return `rep:${ja4}:${ipPrefix(k.ip)}:${uaCohort(k.ua)}`;
}

function scoreFromCounts(humans: number, bots: number): number {
  // Start neutral, drift ±5 per net observation, clamp to [0, 100].
  const net = humans - bots;
  return Math.max(0, Math.min(100, 50 + net * 5));
}

function tierFromScore(score: number): Tier {
  if (score >= 70) return 'trusted';
  if (score < 30) return 'risky';
  return 'standard';
}

const TIER_DIFFICULTY_DELTA: Record<Tier, number> = {
  trusted: -2,
  standard: 0,
  risky: 4,
};

export function adaptDifficulty(base: number, tier: Tier, min = 12, max = 26): number {
  const target = base + TIER_DIFFICULTY_DELTA[tier];
  return Math.max(min, Math.min(max, target));
}

export async function lookup(k: RepKey): Promise<RepRecord> {
  const empty: RepRecord = { humans: 0, bots: 0, anomalies: 0, lastSeen: 0, avgPowMs: 0, score: 50, tier: 'standard' };
  const c = await getClient();
  if (!c) return empty;
  try {
    const h = await c.hGetAll(repKeyOf(k));
    if (!h || Object.keys(h).length === 0) return empty;
    const humans = Number(h.humans ?? 0);
    const bots = Number(h.bots ?? 0);
    const anomalies = Number(h.anomalies ?? 0);
    const lastSeen = Number(h.lastSeen ?? 0);
    const avgPowMs = Number(h.avgPowMs ?? 0);
    const score = scoreFromCounts(humans, bots);
    return { humans, bots, anomalies, lastSeen, avgPowMs, score, tier: tierFromScore(score) };
  } catch (err) {
    console.warn('[reputation] lookup failed:', (err as Error).message);
    return empty;
  }
}

interface UpdateOpts {
  outcome: 'human' | 'bot';
  powDurationMs?: number | null;
  anomaly?: boolean;
  ttlSeconds?: number;
}

// 30-day rolling window — long enough to catch repeat scrapers, short enough
// that a corrected fingerprint stack can rebuild reputation.
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function update(k: RepKey, opts: UpdateOpts): Promise<void> {
  const c = await getClient();
  if (!c) return;
  const key = repKeyOf(k);
  const now = Date.now();
  try {
    const tx = c.multi();
    if (opts.outcome === 'human') tx.hIncrBy(key, 'humans', 1);
    else tx.hIncrBy(key, 'bots', 1);
    if (opts.anomaly) tx.hIncrBy(key, 'anomalies', 1);
    tx.hSet(key, 'lastSeen', String(now));
    if (typeof opts.powDurationMs === 'number' && opts.powDurationMs >= 0) {
      // Exponential moving average of solve time (alpha=0.2). Bot stacks tend
      // to be much faster than humans, so this surfaces fast-solver buckets.
      const cur = await c.hGet(key, 'avgPowMs');
      const prev = cur ? Number(cur) : 0;
      const next = prev > 0 ? Math.round(prev * 0.8 + opts.powDurationMs * 0.2) : opts.powDurationMs;
      tx.hSet(key, 'avgPowMs', String(next));
    }
    tx.expire(key, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    await tx.exec();
  } catch (err) {
    console.warn('[reputation] update failed:', (err as Error).message);
  }
}

// Export the cohort/prefix helpers so tests can pin them.
export const _internal = { uaCohort, ipPrefix, scoreFromCounts, tierFromScore };
