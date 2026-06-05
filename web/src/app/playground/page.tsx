'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  User,
  Wallet,
} from 'lucide-react';
import { SiteHeader } from '@/components/SiteHeader';
import { Turnstile } from '@/components/Turnstile';
import { PaymentTrace, type Trace } from '@/components/playground/PaymentTrace';
import { AccessProbe, type Probe } from '@/components/playground/AccessProbe';
import {
  TURNSTILE_SITE_KEY,
  shortAddress,
  startSession,
  streamChat,
  type Balances,
  type PgEvent,
  type PlaygroundSession,
} from '@/lib/playground';

type Item =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'trace'; trace: Trace }
  | { id: string; kind: 'probe'; probe: Probe };

const SUGGESTIONS = [
  'Try accessing the demo WITHOUT paying',
  'Now pay and unlock the content',
  'Show me both: blocked vs paid',
];

let counter = 0;
const nextId = () => `i${++counter}`;

export default function PlaygroundPage() {
  const [session, setSession] = useState<PlaygroundSession | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [token, setToken] = useState('');

  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const traceIdRef = useRef<string | null>(null);
  const probeIdRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, status]);

  const handleToken = useCallback((t: string) => setToken(t), []);

  async function handleStart() {
    setStarting(true);
    setStartError(null);
    try {
      const s = await startSession(token);
      setSession(s);
      setBalances(s.balances);
      setItems([
        {
          id: nextId(),
          kind: 'assistant',
          text: "Hi! I'm a Verivyx x402 agent running in a sandboxed Stellar testnet. I control the wallet on the right. Ask me to unlock the demo content and I'll pay for it on-chain.",
        },
      ]);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session');
    } finally {
      setStarting(false);
    }
  }

  function resetSession() {
    setSession(null);
    setBalances(null);
    setItems([]);
    setInput('');
    setStatus(null);
    setToken('');
    setStartError(null);
  }

  function onEvent(e: PgEvent) {
    switch (e.type) {
      case 'status':
        setStatus(e.text);
        break;
      case 'tool_call': {
        const id = nextId();
        if (e.paid) {
          traceIdRef.current = id;
          setItems((prev) => [
            ...prev,
            { id, kind: 'trace', trace: { url: e.url, method: e.method, phase: 'fetching' } },
          ]);
        } else {
          probeIdRef.current = id;
          setItems((prev) => [
            ...prev,
            { id, kind: 'probe', probe: { url: e.url, method: e.method, phase: 'checking' } },
          ]);
        }
        break;
      }
      case 'access_check': {
        const id = probeIdRef.current;
        setItems((prev) =>
          prev.map((it) =>
            it.id === id && it.kind === 'probe'
              ? {
                  ...it,
                  probe: {
                    ...it.probe,
                    phase: e.error ? 'error' : e.blocked ? 'blocked' : 'allowed',
                    status: e.status,
                    error: e.error,
                  },
                }
              : it,
          ),
        );
        break;
      }
      case 'payment': {
        const id = traceIdRef.current;
        setItems((prev) =>
          prev.map((it) =>
            it.id === id && it.kind === 'trace'
              ? {
                  ...it,
                  trace: {
                    ...it.trace,
                    phase: e.paymentMade ? 'settled' : 'failed',
                    paymentMade: e.paymentMade,
                    status: e.status,
                    transaction: e.transaction,
                    amount: e.amount,
                    error: e.error,
                  },
                }
              : it,
          ),
        );
        break;
      }
      case 'assistant':
        setItems((prev) => [...prev, { id: nextId(), kind: 'assistant', text: e.content }]);
        setStatus(null);
        break;
      case 'balances':
        setBalances(e.balances);
        break;
      case 'error':
        setItems((prev) => [...prev, { id: nextId(), kind: 'error', text: e.message }]);
        setStatus(null);
        break;
      case 'final':
        break;
    }
  }

  async function send(text: string) {
    const msg = text.trim();
    if (!session || busy || !msg) return;
    setItems((prev) => [...prev, { id: nextId(), kind: 'user', text: msg }]);
    setInput('');
    setBusy(true);
    setStatus('thinking');
    try {
      await streamChat(session.sessionId, msg, onEvent);
    } catch (e) {
      setItems((prev) => [
        ...prev,
        { id: nextId(), kind: 'error', text: e instanceof Error ? e.message : 'Agent error' },
      ]);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function copyAddress() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }

  const canStart = !starting && (!TURNSTILE_SITE_KEY || token.length > 0);

  return (
    <>
      <SiteHeader variant="auth" />

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="max-w-2xl">
          <div className="tag-chip">
            <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-yellow)]" />
            Sandbox · Stellar testnet
          </div>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
            x402 Playground
          </h1>
          <p className="mt-3 text-base text-[var(--color-ink-500)]">
            Chat with an AI agent that pays for content the way real agents do. It holds a
            pre-funded testnet wallet and settles a USDC micropayment over the x402 protocol —
            live, on-chain, every step visible.
          </p>
        </div>

        {!session ? (
          <Gate
            starting={starting}
            canStart={canStart}
            error={startError}
            siteKey={TURNSTILE_SITE_KEY}
            onToken={handleToken}
            onStart={handleStart}
          />
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Chat */}
            <div className="lg:col-span-2">
              <div className="surface-card flex h-[32rem] flex-col">
                <div
                  ref={scrollRef}
                  className="flex-1 space-y-4 overflow-y-auto p-5"
                >
                  {items.map((it) => (
                    <MessageRow key={it.id} item={it} />
                  ))}
                  {status ? <StatusRow text={status} /> : null}
                </div>

                <div className="border-t border-[var(--color-cream-200)] p-3">
                  {items.length <= 1 && !busy ? (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {SUGGESTIONS.map((s) => (
                        <button
                          key={s}
                          onClick={() => send(s)}
                          className="rounded-full border border-[var(--color-cream-200)] px-3 py-1 text-xs text-[var(--color-ink-700)] transition hover:border-[var(--color-ink-300)] hover:bg-[var(--color-cream-50)]"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      send(input);
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      disabled={busy}
                      placeholder="Ask the agent to unlock the demo…"
                      className="flex-1 rounded-lg border border-[var(--color-cream-200)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-ink-300)] disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      disabled={busy || !input.trim()}
                      className="btn-yellow text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </form>
                </div>
              </div>
            </div>

            {/* Sandbox sidebar */}
            <Sidebar
              session={session}
              balances={balances}
              copied={copied}
              busy={busy}
              onCopy={copyAddress}
              onReset={resetSession}
            />
          </div>
        )}
      </main>
    </>
  );
}

function Gate({
  starting,
  canStart,
  error,
  siteKey,
  onToken,
  onStart,
}: {
  starting: boolean;
  canStart: boolean;
  error: string | null;
  siteKey: string;
  onToken: (t: string) => void;
  onStart: () => void;
}) {
  return (
    <div className="mt-8 max-w-xl">
      <div className="surface-card p-8">
        <div className="grid grid-cols-3 gap-4 border-b border-[var(--color-cream-200)] pb-6">
          {[
            { icon: <Wallet className="h-5 w-5" />, label: 'Funded wallet' },
            { icon: <ShieldCheck className="h-5 w-5" />, label: 'Sandboxed' },
            { icon: <Sparkles className="h-5 w-5" />, label: 'Free model' },
          ].map((f) => (
            <div key={f.label} className="flex flex-col items-center gap-2 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
                {f.icon}
              </span>
              <span className="text-xs text-[var(--color-ink-500)]">{f.label}</span>
            </div>
          ))}
        </div>

        <p className="mt-6 text-sm text-[var(--color-ink-700)]">
          Start a sandboxed session and we&apos;ll hand the agent a fresh Stellar testnet wallet
          pre-loaded with test USDC. Nothing here touches mainnet or real funds.
        </p>

        <div className="mt-6 flex flex-col items-center gap-4">
          {siteKey ? <Turnstile siteKey={siteKey} onToken={onToken} /> : null}
          <button
            onClick={onStart}
            disabled={!canStart}
            className="btn-yellow w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Provisioning wallet…
              </>
            ) : (
              <>
                <Sparkles size={18} /> Start sandbox
              </>
            )}
          </button>
        </div>

        {error ? (
          <p className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
            <TriangleAlert size={16} /> {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MessageRow({ item }: { item: Item }) {
  if (item.kind === 'trace') return <PaymentTrace trace={item.trace} />;
  if (item.kind === 'probe') return <AccessProbe probe={item.probe} />;

  if (item.kind === 'user') {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-[var(--color-ink-900)] px-4 py-2 text-sm text-white">
          {item.text}
        </div>
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-cream-200)] text-[var(--color-ink-700)]">
          <User size={15} />
        </span>
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-rose)] text-white">
          <TriangleAlert size={15} />
        </span>
        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-[var(--color-stellar-rose)]/10 px-4 py-2 text-sm text-[var(--color-stellar-rose)]">
          {item.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
        <Bot size={15} />
      </span>
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-[var(--color-cream-100)] px-4 py-2 text-sm text-[var(--color-ink-900)]">
        {item.text}
      </div>
    </div>
  );
}

function StatusRow({ text }: { text: string }) {
  const label =
    text === 'paying'
      ? 'Paying on Stellar…'
      : text === 'checking'
        ? 'Checking access (no payment)…'
        : 'Thinking…';
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-ink-500)]">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
        <Bot size={15} />
      </span>
      <Loader2 size={14} className="animate-spin" />
      {label}
    </div>
  );
}

function Sidebar({
  session,
  balances,
  copied,
  busy,
  onCopy,
  onReset,
}: {
  session: PlaygroundSession;
  balances: Balances | null;
  copied: boolean;
  busy: boolean;
  onCopy: () => void;
  onReset: () => void;
}) {
  return (
    <aside className="space-y-4">
      <div className="surface-card p-5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Wallet size={16} /> Agent wallet
          </span>
          <span className="tag-chip">{session.network}</span>
        </div>

        <button
          onClick={onCopy}
          className="mt-3 flex w-full items-center justify-between rounded-lg border border-[var(--color-cream-200)] px-3 py-2 font-mono text-xs text-[var(--color-ink-700)] transition hover:bg-[var(--color-cream-50)]"
        >
          {shortAddress(session.walletAddress)}
          {copied ? (
            <Check size={14} className="text-[var(--color-stellar-mint)]" />
          ) : (
            <Copy size={14} className="text-[var(--color-ink-300)]" />
          )}
        </button>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Balance label="USDC" value={balances?.usdc} highlight />
          <Balance label="XLM" value={balances?.xlm} />
        </div>
        <p className="mt-3 text-xs text-[var(--color-ink-500)]">
          Balance updates after each on-chain payment.
        </p>
      </div>

      <button
        onClick={onReset}
        disabled={busy}
        className="btn-ghost w-full justify-center text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw size={15} /> New session
      </button>

      <p className="px-1 text-xs text-[var(--color-ink-300)]">
        Sessions are sandboxed and expire after a few minutes of inactivity. Testnet only — no real
        funds involved.
      </p>
    </aside>
  );
}

function Balance({
  label,
  value,
  highlight,
}: {
  label: string;
  value?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg p-3 ${
        highlight ? 'bg-[var(--color-stellar-yellow-soft)]' : 'bg-[var(--color-cream-100)]'
      }`}
    >
      <p className="font-mono text-xs text-[var(--color-ink-500)]">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold text-[var(--color-ink-900)]">
        {value ?? '—'}
      </p>
    </div>
  );
}
