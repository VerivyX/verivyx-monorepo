'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Copy,
  Globe,
  Heart,
  LogOut,
  RefreshCw,
  Terminal,
  Wallet,
  Zap,
} from 'lucide-react';
import { api, clearSession, getStoredUser, type CreatorUser } from '@/lib/api';

// ─── CodeBlock ──────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Very simple token colorizer: split by whitespace-preserving regex
  // and color curl command, flags (--/-H/-d etc.), and quoted strings
  const tokens = code.split(/(\s+)/);

  return (
    <div className="relative rounded-xl bg-[var(--color-ink-900)] border border-white/10 overflow-hidden">
      <button
        onClick={copy}
        className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/20 transition-colors"
        aria-label="Copy code"
      >
        {copied ? <CheckCircle2 size={11} className="text-emerald-400" /> : <Copy size={11} />}
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre className="overflow-x-auto p-4 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {tokens.map((token, i) => {
          if (/^\s+$/.test(token)) return token;
          if (token === 'curl') return <span key={i} className="text-yellow-300 font-bold">{token}</span>;
          if (/^(-i|-X|-H|-d|--data|--header|--request)$/.test(token)) return <span key={i} className="text-white/70">{token}</span>;
          if (/^(-X|-H|-d)$/.test(token)) return <span key={i} className="text-white/70">{token}</span>;
          if (/^'[^']*'$/.test(token)) return <span key={i} className="text-sky-300">{token}</span>;
          if (/^"[^"]*"$/.test(token)) return <span key={i} className="text-sky-300">{token}</span>;
          if (/^https?:\/\//.test(token)) return <span key={i} className="text-sky-400">{token}</span>;
          if (/^\\$/.test(token)) return <span key={i} className="text-white/40">{token}</span>;
          return <span key={i} className="text-white">{token}</span>;
        })}
      </pre>
    </div>
  );
}

// ─── StepCard ────────────────────────────────────────────────────────────────

function StepCard({
  step,
  title,
  description,
  code,
  accentColor,
}: {
  step: number;
  title: string;
  description: string;
  code: string;
  accentColor: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center gap-2 shrink-0">
        <div
          className={`grid h-8 w-8 place-items-center rounded-full text-xs font-bold shrink-0 ${accentColor}`}
        >
          {step}
        </div>
        <div className="w-px flex-1 bg-[var(--color-cream-200)] min-h-[1rem]" />
      </div>
      <div className="flex-1 pb-6">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-xs text-[var(--color-ink-500)]">{description}</p>
        <div className="mt-3">
          <CodeBlock code={code} />
        </div>
      </div>
    </div>
  );
}

// ─── SectionHeader ───────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  subtitle,
  borderColor,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  borderColor: string;
}) {
  return (
    <div className={`flex items-start gap-3 rounded-2xl border-l-4 bg-white p-5 shadow-sm ${borderColor}`}>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-xs text-[var(--color-ink-500)]">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TestPage() {
  const router = useRouter();
  const [user, setUser] = useState<CreatorUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.me();
      if (res.user.needsOnboarding) { router.replace('/onboarding'); return; }
      setUser(res.user);
    } catch {
      clearSession();
      router.push('/login');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!getStoredUser()) { router.replace('/login'); return; }
    load();
  }, [router, load]);

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  if (!origin) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Detecting environment…
        </div>
      </div>
    );
  }

  const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
  const domain = user.domain ?? '';
  const payTo = user.stellar_address ?? '';
  const amountAtoms = Math.round(user.pricePerRequest * 1e7).toString();
  const platformFeeAtoms = Math.round((user.platformFee ?? 0.001) * 1e7).toString();
  const creatorAtoms = Math.round((user.pricePerRequest - (user.platformFee ?? 0.001)) * 1e7).toString();

  // Bot/AI flow steps
  const botSteps = [
    {
      title: 'Check price (quote)',
      description: 'Discover the USDC price, asset contract, and destination address for this domain.',
      code: `curl '${origin}/api/v1/payment/requirements?domain=${domain}'`,
    },
    {
      title: 'Hit content gate — expect 402',
      description: 'Bot UA triggers the paywall. Server responds with 402 Payment Required and payment instructions.',
      code: `curl -X POST ${origin}/api/v1/content/hydrate \\
  -H 'Content-Type: application/json' \\
  -H 'User-Agent: GPTBot/1.0' \\
  -d '{"domain":"${domain}","slug":"test"}'`,
    },
    {
      title: 'Sign + retry with PAYMENT-SIGNATURE',
      description:
        'The agent builds a signed Stellar transaction for one of the two rails, then retries the SAME hydrate endpoint with the PAYMENT-SIGNATURE header (X-PAYMENT also accepted). Soroban rail: a single USDC.transfer to the paywall contract — the keeper then splits on-chain. Classic rail: two payment ops straight to creator + platform. Building the signed XDR is what @x402/stellar or the Verivyx SDK does — it cannot be hand-written in curl.',
      code: `# header value = base64(JSON PaymentPayload), built + signed by an x402 client
curl -X POST ${origin}/api/v1/content/hydrate \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: test-key-001' \\
  -H 'PAYMENT-SIGNATURE: <base64-signed-payment-payload>' \\
  -d '{"domain":"${domain}","slug":"test"}'

# Soroban rail quote (payTo = paywall contract, fees sponsored):
#   amount   ${amountAtoms}  asset ${USDC}
#   split on-chain → creator ${creatorAtoms} · platform ${platformFeeAtoms}`,
    },
    {
      title: 'Access granted — expect 200',
      description:
        'Once the payment settles (and, on the Soroban rail, the contract distributes the split), the gate returns 200 with a PAYMENT-RESPONSE header. The session is cached so further requests pass for up to 1 hour.',
      code: `curl -X POST ${origin}/api/v1/content/hydrate \\
  -H 'Content-Type: application/json' \\
  -H 'User-Agent: GPTBot/1.0' \\
  -d '{"domain":"${domain}","slug":"test"}'`,
    },
  ];

  // Human flow steps
  const humanSteps = [
    {
      title: 'Request PoW challenge',
      description: 'The server issues a proof-of-work puzzle that a real browser must solve.',
      code: `curl -X POST ${origin}/api/v1/auth/challenge \\
  -H 'Content-Type: application/json' \\
  -d '{"domain":"${domain}","slug":"test"}'`,
    },
    {
      title: 'Verify human (solve PoW, then submit)',
      description: 'After solving the puzzle in browser JS, POST the challenge ID, winning nonce, and solve duration.',
      code: `curl -X POST ${origin}/api/v1/auth/verify-human \\
  -H 'Content-Type: application/json' \\
  -d '{
  "challenge": "<challenge-id-from-step-1>",
  "nonce": "<winning-nonce>",
  "powDurationMs": 312
}'`,
    },
  ];

  // Health checks
  const healthChecks = [
    { label: 'Auth service', code: `curl ${origin}/api/v1/auth/health` },
    { label: 'Payment service', code: `curl ${origin}/api/v1/payment/health` },
    { label: 'Content service', code: `curl ${origin}/api/v1/content/health` },
  ];

  return (
    <div className="min-h-screen bg-[var(--color-cream-50)]">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/dashboard" className="btn-ghost text-sm">
              <ArrowLeft size={14} /> Dashboard
            </Link>
            <span className="text-[var(--color-ink-500)]">/</span>
            <p className="font-semibold tracking-tight">Test integration</p>
          </div>
          <button
            onClick={() => { clearSession(); router.push('/'); }}
            className="btn-primary text-sm"
          >
            <LogOut size={14} /> Logout
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        {/* Page title */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Integration · {domain}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Test your integration</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-500)]">
            Run these curl commands from a terminal to walk through each access flow end-to-end.
          </p>
        </div>

        {/* Live settlement banner */}
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-[var(--color-cream-200)] bg-white px-4 py-3">
          <Zap size={15} className="mt-0.5 shrink-0 text-[var(--color-stellar-mint)]" />
          <p className="text-xs text-[var(--color-ink-700)]">
            <span className="font-semibold">Live settlement</span> — payments settle for real on
            Stellar. The quote and gate steps below run as-is; the settle step needs a real
            signed Stellar transaction, which the{' '}
            <span className="font-mono">@x402/stellar</span> client or the Verivyx SDK builds for
            you.
          </p>
        </div>

        {/* Creator info sidebar card */}
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--color-cream-200)] bg-white px-4 py-3 shadow-sm">
            <Globe size={14} className="shrink-0 text-[var(--color-ink-500)]" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-ink-500)]">Domain</p>
              <p className="mt-0.5 truncate font-mono text-xs font-semibold">{domain}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-[var(--color-cream-200)] bg-white px-4 py-3 shadow-sm">
            <Terminal size={14} className="shrink-0 text-[var(--color-ink-500)]" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-ink-500)]">Price per request</p>
              <p className="mt-0.5 font-mono text-xs font-semibold">${user.pricePerRequest.toFixed(4)} USDC</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-[var(--color-cream-200)] bg-white px-4 py-3 shadow-sm">
            <Wallet size={14} className="shrink-0 text-[var(--color-ink-500)]" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-ink-500)]">Stellar wallet</p>
              <p className="mt-0.5 truncate font-mono text-xs font-semibold">
                {payTo.slice(0, 6)}…{payTo.slice(-4)}
              </p>
            </div>
          </div>
        </div>

        {/* ── Section 1: Bot/AI Agent Flow ─────────────────────────────────── */}
        <div className="mt-10">
          <SectionHeader
            icon={<Bot size={18} className="text-indigo-500" />}
            title="Bot / AI Agent Flow"
            subtitle="Walk through the full x402 payment cycle as an AI agent would experience it."
            borderColor="border-indigo-400"
          />
          <div className="mt-6">
            {botSteps.map((s, idx) => (
              <StepCard
                key={idx}
                step={idx + 1}
                title={s.title}
                description={s.description}
                code={s.code}
                accentColor="bg-indigo-100 text-indigo-700"
              />
            ))}
          </div>
        </div>

        {/* ── Section 2: Human Verification Flow ───────────────────────────── */}
        <div className="mt-6">
          <SectionHeader
            icon={<Heart size={18} className="text-emerald-500" />}
            title="Human Verification Flow"
            subtitle="Simulate the proof-of-work challenge that real browsers solve to gain free access."
            borderColor="border-emerald-400"
          />
          <div className="mt-6">
            {humanSteps.map((s, idx) => (
              <StepCard
                key={idx}
                step={idx + 1}
                title={s.title}
                description={s.description}
                code={s.code}
                accentColor="bg-emerald-100 text-emerald-700"
              />
            ))}
          </div>
        </div>

        {/* ── Section 3: System Health ──────────────────────────────────────── */}
        <div className="mt-6">
          <SectionHeader
            icon={<Zap size={18} className="text-slate-500" />}
            title="System Health"
            subtitle="Quick pings to verify each service is up and responding."
            borderColor="border-slate-300"
          />
          <div className="mt-6 flex flex-col gap-4">
            {healthChecks.map((h) => (
              <div key={h.label} className="flex gap-4">
                <div className="flex flex-col items-center gap-2 shrink-0">
                  <div className="grid h-8 w-8 place-items-center rounded-full bg-slate-100 text-slate-500">
                    <span className="h-2 w-2 rounded-full bg-slate-400 block" />
                  </div>
                </div>
                <div className="flex-1 pb-4">
                  <p className="text-xs font-semibold text-[var(--color-ink-500)] mb-2">{h.label}</p>
                  <CodeBlock code={h.code} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
