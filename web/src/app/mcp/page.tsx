'use client';

import React, { useCallback, useState } from 'react';
import {
  ArrowRight,
  Check,
  Loader2,
  ShieldCheck,
  Boxes,
  Zap,
  Plug,
  MessageSquare,
  ReceiptText,
  Sparkles,
} from 'lucide-react';

import { SubdomainHeader } from '@/components/SubdomainHeader';
import { SiteFooter } from '@/components/SiteFooter';
import { Turnstile, TURNSTILE_SITE_KEY } from '@/components/Turnstile';
import { api } from '@/lib/api';

const CHAINS = ['Stellar', 'Base', 'Solana'] as const;

const STEPS = [
  {
    icon: <Plug className="h-5 w-5" />,
    step: '01',
    title: 'Connect once',
    body: 'Add mcp.verivyx.com to Claude, Cursor, or any MCP client. One URL, one key — no SDK, no glue code.',
  },
  {
    icon: <MessageSquare className="h-5 w-5" />,
    step: '02',
    title: 'Let your agent ask',
    body: 'Your AI calls a paid API or page. Hits an HTTP 402? The MCP handles the payment handshake automatically.',
  },
  {
    icon: <ReceiptText className="h-5 w-5" />,
    step: '03',
    title: 'Paid in seconds',
    body: 'USDC settles on-chain, the agent gets its content, and you get a clean receipt. Non-custodial, every time.',
  },
];

const VALUES = [
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: 'Non-custodial',
    body: 'Funds stay in your wallet. Verivyx signs payments you authorize — it never holds your money.',
  },
  {
    icon: <Boxes className="h-5 w-5" />,
    title: 'Multi-chain, auto-routed',
    body: 'Stellar, Base, and Solana from one connection. The resource picks the chain — we handle the rest.',
  },
  {
    icon: <Zap className="h-5 w-5" />,
    title: 'One flat fee',
    body: 'A simple $0.001 per payment. No subscriptions, no minimums, no lock-in — you only pay when your agent does.',
  },
];

const FAQ = [
  {
    q: 'What is x402?',
    a: 'x402 is the open HTTP-native payment standard — a server replies with “402 Payment Required”, the client pays in stablecoins, and retries. Verivyx makes any AI agent fluent in it.',
  },
  {
    q: 'Which AI clients work?',
    a: 'Any MCP-compatible client — Claude Desktop, Claude Code, Cursor, and custom agents. You connect the remote MCP server with a single URL.',
  },
  {
    q: 'Is it custodial?',
    a: 'No. Your wallet keeps custody; you grant a capped, revocable spending authorization. Verivyx can never move funds beyond what you allow.',
  },
  {
    q: 'What does it cost?',
    a: 'A flat $0.001 service fee per successful payment, on top of whatever the resource charges. Network gas is a fraction of a cent.',
  },
];

export default function McpComingSoonPage() {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captchaOk = !TURNSTILE_SITE_KEY || token.length > 0;
  const handleToken = useCallback((t: string) => setToken(t), []);
  const clearToken = useCallback(() => {
    setToken('');
    setCaptchaKey((k) => k + 1);
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
        setError('Please enter a valid email.');
        return;
      }
      setLoading(true);
      try {
        await api.mcpWaitlist({ email: email.trim().toLowerCase(), turnstileToken: token });
        setDone(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
        clearToken();
      } finally {
        setLoading(false);
      }
    },
    [email, token, clearToken],
  );

  return (
    <div className="min-h-screen bg-white text-[var(--color-ink-900)]">
      <SubdomainHeader label="MCP" />

      {/* Hero */}
      <section className="border-b border-[var(--color-cream-200)] bg-[var(--color-cream-50)]">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-6 py-20 md:grid-cols-2 md:py-28">
          <div>
            <span className="tag-chip bg-[var(--color-stellar-violet-soft)] text-[var(--color-ink-900)]">
              <Sparkles className="mr-1 inline h-3.5 w-3.5" /> Early access
            </span>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
              Pay for anything.{' '}
              <span className="bg-[var(--color-stellar-yellow-soft)] px-2">Let your AI handle it.</span>
            </h1>
            <p className="mt-5 max-w-md text-lg text-[var(--color-ink-500)]">
              The Verivyx x402 MCP — one connection that lets any AI agent pay for any x402 resource,
              across chains, non-custodially.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {CHAINS.map((c) => (
                <span key={c} className="tag-chip bg-white text-[var(--color-ink-700)]">
                  {c}
                </span>
              ))}
              <span className="text-sm text-[var(--color-ink-400)]">· built on the open x402 standard</span>
            </div>
          </div>

          {/* Waitlist card */}
          <div id="waitlist" className="md:justify-self-end">
            {done ? (
              <div className="surface-card w-full max-w-md p-8 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
                  <Check className="h-6 w-6" />
                </div>
                <h2 className="mt-4 text-xl font-semibold">You&apos;re on the list ✦</h2>
                <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                  We&apos;ll email you the moment early access opens. Check your inbox for a confirmation.
                </p>
              </div>
            ) : (
              <form onSubmit={submit} className="surface-card w-full max-w-md p-6">
                <label htmlFor="mcp-email" className="block text-sm font-semibold">
                  Get early access
                </label>
                <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                  Be first to connect your agent when we open the doors.
                </p>
                <input
                  id="mcp-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-4 w-full rounded-xl border border-[var(--color-cream-200)] bg-white px-4 py-3 text-sm focus:border-[var(--color-stellar-yellow)] focus:outline-none"
                />

                {/* Bot protection — must be solved before the button enables. */}
                {TURNSTILE_SITE_KEY && (
                  <div className="mt-4">
                    <Turnstile key={captchaKey} siteKey={TURNSTILE_SITE_KEY} onToken={handleToken} onError={clearToken} />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !captchaOk}
                  className="btn-yellow mt-4 w-full justify-center text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {!captchaOk && TURNSTILE_SITE_KEY ? 'Complete the check above' : 'Notify me'}
                </button>

                {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
                <p className="mt-3 text-center text-xs text-[var(--color-ink-400)]">No spam. One email when we launch.</p>
              </form>
            )}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-6">
        {/* Tool-call demo */}
        <section className="py-16">
          <div className="surface-card mx-auto max-w-2xl overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b border-[var(--color-cream-200)] px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-[var(--color-cream-200)]" />
              <span className="h-3 w-3 rounded-full bg-[var(--color-cream-200)]" />
              <span className="h-3 w-3 rounded-full bg-[var(--color-cream-200)]" />
              <span className="ml-2 font-mono text-xs text-[var(--color-ink-400)]">agent ↔ mcp.verivyx.com</span>
            </div>
            <div className="space-y-2 px-5 py-5 font-mono text-[13px] leading-relaxed text-[var(--color-ink-700)]">
              <div>
                &gt; <span className="text-[var(--color-stellar-violet)]">pay_for_resource</span>(&quot;https://api.example.com/report&quot;)
              </div>
              <div className="text-[var(--color-ink-500)]">chain&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;solana:devnet</div>
              <div className="text-[var(--color-ink-500)]">resource&nbsp;&nbsp;&nbsp;0.010 USDC</div>
              <div className="text-[var(--color-ink-500)]">service fee&nbsp;0.001 USDC&nbsp;&nbsp;&rarr; Verivyx</div>
              <div>
                status&nbsp;&nbsp;&nbsp;&nbsp;<span className="rounded-md bg-[var(--color-stellar-yellow-soft)] px-2 py-0.5">200 OK · paid ✓</span>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="py-12">
          <h2 className="text-center text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-[var(--color-ink-500)]">
            From “402 Payment Required” to paid content — without your agent ever touching a private key.
          </p>
          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.step} className="surface-card relative p-6">
                <span className="absolute right-5 top-5 font-mono text-sm text-[var(--color-ink-300)]">{s.step}</span>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]">
                  {s.icon}
                </span>
                <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-[var(--color-ink-500)]">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Value props */}
        <section className="grid grid-cols-1 gap-6 py-12 md:grid-cols-3">
          {VALUES.map((v) => (
            <div key={v.title} className="surface-card p-6">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-stellar-yellow-soft)] text-[var(--color-ink-900)]">
                {v.icon}
              </span>
              <h3 className="mt-4 text-lg font-semibold">{v.title}</h3>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">{v.body}</p>
            </div>
          ))}
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-2xl py-12">
          <h2 className="text-center text-3xl font-semibold tracking-tight">Questions</h2>
          <div className="surface-card mt-8 divide-y divide-[var(--color-cream-200)] p-0">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
                  {f.q}
                  <span className="ml-4 text-[var(--color-ink-400)] transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm text-[var(--color-ink-500)]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-16">
          <div className="surface-card overflow-hidden p-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Give your agent a wallet.</h2>
            <p className="mx-auto mt-3 max-w-md text-[var(--color-ink-500)]">
              Early access opens soon. Join the waitlist and we&apos;ll reach out first.
            </p>
            <a href="#waitlist" className="btn-yellow mt-6 text-sm">
              Join the waitlist <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </section>
      </div>

      <SiteFooter />
    </div>
  );
}
