// Client for the sandboxed x402 playground (playground-agent service).
//
// In production the playground is served at playground.verivyx.com, where nginx
// proxies /api/v1/playground/* to the playground-agent container — so the base
// is same-origin (''). In dev, playground-agent runs on :8087.
const PLAYGROUND_API =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_PLAYGROUND_API) ||
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8087');

// Cloudflare Turnstile site key (public). Empty → dev bypass (backend skips
// verification when its secret is also empty).
export const TURNSTILE_SITE_KEY =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) || '';

export type Balances = { usdc: string; xlm: string };

// Which resource the agent works against: the isolated sandbox demo, or a real
// Verivyx-protected WordPress post on web-test.verivyx.com.
export type PlaygroundTarget = 'demo' | 'webtest';

export type PlaygroundSession = {
  sessionId: string;
  walletAddress: string;
  balances: Balances;
  demoSlug: string;
  targets?: Record<PlaygroundTarget, string>;
  network: string;
  model: string;
};

// Mirrors AgentEvent in playground-agent/src/agentLoop.ts, plus the `balances`
// frame the index.ts handler appends after each turn. Types are duplicated by
// design — services never share source (boundary rule).
export type PgEvent =
  | { type: 'status'; text: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool_call'; url: string; method: string; paid: boolean }
  | {
      type: 'payment';
      paymentMade: boolean;
      status?: number;
      transaction?: string;
      amount?: string;
      error?: string;
    }
  | { type: 'access_check'; status?: number; blocked: boolean; error?: string }
  | { type: 'balances'; balances: Balances }
  | { type: 'final' }
  | { type: 'error'; message: string };

async function parseError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text) as { error?: string; detail?: string };
    return data.detail || data.error || `Request failed with ${res.status}`;
  } catch {
    return text || `Request failed with ${res.status}`;
  }
}

// Acquire a funded testnet wallet + spawn its MCP server. `turnstileToken` may be
// empty in dev (backend bypasses when its secret is unset).
export async function startSession(turnstileToken: string): Promise<PlaygroundSession> {
  const res = await fetch(`${PLAYGROUND_API}/api/v1/playground/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as PlaygroundSession;
}

// Stream one chat turn. Calls `onEvent` for every SSE frame until the stream
// closes ([DONE]). The returned promise resolves when the stream ends.
export async function streamChat(
  sessionId: string,
  message: string,
  onEvent: (e: PgEvent) => void,
  target: PlaygroundTarget = 'demo',
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${PLAYGROUND_API}/api/v1/playground/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, target }),
    signal,
  });
  if (!res.ok) throw new Error(await parseError(res));
  if (!res.body) throw new Error('No response stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onEvent(JSON.parse(payload) as PgEvent);
      } catch {
        // Ignore malformed frames rather than tearing down the whole turn.
      }
    }
  }
}

// stellar.expert tx link for the playground (testnet only — this service refuses
// to run on any other network).
export function testnetTxLink(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

// Compact a Stellar address for display: GABC…WXYZ.
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-5)}` : addr;
}
