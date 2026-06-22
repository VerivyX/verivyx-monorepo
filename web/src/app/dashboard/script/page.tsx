'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  LogOut,
  RefreshCw,
  Server,
  Zap,
  X,
} from 'lucide-react';
import { api, clearSession, getStoredUser, type CreatorUser } from '@/lib/api';

function buildScriptTag(domain: string): string {
  const embedUrl = process.env.NEXT_PUBLIC_EMBED_URL ?? '';
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
  return `<script
  src="${embedUrl}/gate.min.js"
  data-domain="${domain}"
  data-api="${apiUrl}"
  async
></script>`;
}

export default function ScriptPage() {
  const router = useRouter();
  const [user, setUser] = useState<CreatorUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const meRes = await api.me();
      if (meRes.user.needsOnboarding) { router.replace('/onboarding'); return; }
      setUser(meRes.user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load';
      setError(msg);
      if (msg.toLowerCase().includes('token')) {
        clearSession();
        router.push('/login');
      }
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) {
      router.replace('/login');
      return;
    }
    setUser(stored);
    load();
  }, [router, load]);

  const handleCopy = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(buildScriptTag(user.domain ?? ''));
      setCopied(true);
      showToast('Script tag copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Failed to copy to clipboard. Please select and copy manually.');
    }
  };

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Loading script generator…
        </div>
      </div>
    );
  }

  const scriptTag = buildScriptTag(user.domain ?? '');

  return (
    <div className="min-h-screen bg-[var(--color-cream-50)]">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="btn-ghost text-sm">
              <ArrowLeft size={14} /> Dashboard
            </Link>
            <span className="text-sm text-[var(--color-ink-500)]">/</span>
            <p className="text-sm font-semibold tracking-tight">Get Script</p>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={load} disabled={refreshing} className="btn-ghost text-sm">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={async () => {
                await api.oauthLogout().catch(() => {});
                clearSession();
                router.push('/');
              }}
              className="btn-primary text-sm"
            >
              <LogOut size={14} /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        {/* Page heading */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Domain · <span className="font-mono normal-case tracking-normal">{user.domain ?? ''}</span>
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
            Embed your paywall
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-[var(--color-ink-500)]">
            Drop this single script tag into your HTML — humans browse free, AI agents settle a
            USDC micropayment on Stellar before they see a single token.
          </p>
        </div>

        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-[var(--color-stellar-rose)] hover:opacity-80"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Script tag card */}
        <section className="surface-card mt-8 overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-cream-200)] px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-rose)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-yellow)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-mint)]" />
              <span className="ml-3 font-mono text-xs text-[var(--color-ink-500)]">
                script tag · paste before &lt;/body&gt;
              </span>
            </div>
            <button onClick={handleCopy} className="btn-yellow text-xs">
              {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied ? 'Copied!' : 'Copy script'}
            </button>
          </div>
          <pre className="overflow-x-auto bg-[var(--color-cream-50)] px-6 py-5 font-mono text-[13px] leading-relaxed text-[var(--color-ink-700)]">
            {scriptTag}
          </pre>
        </section>

        {/* 3-step instructions */}
        <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            {
              step: '01',
              icon: <Copy size={18} />,
              title: 'Copy the script tag',
              body: 'Click "Copy script" above — it\'s pre-configured for your domain and Stellar wallet.',
            },
            {
              step: '02',
              icon: <Code2 size={18} />,
              title: 'Paste before </body>',
              body: 'Add the tag to every page you want protected. One tag per domain, not per page.',
            },
            {
              step: '03',
              icon: <Zap size={18} />,
              title: 'Done — bots start paying',
              body: 'Agents that hit your site will be charged in USDC. Revenue flows directly to your Stellar wallet.',
            },
          ].map((s) => (
            <div key={s.step} className="surface-card surface-card-hover p-6">
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]">
                  {s.icon}
                </span>
                <span className="font-mono text-xs text-[var(--color-ink-300)]">{s.step}</span>
              </div>
              <h3 className="mt-5 text-base font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">{s.body}</p>
            </div>
          ))}
        </section>

        {/* Visual preview — what bots see */}
        <section className="surface-card mt-8 p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Zap size={18} /> What AI agents see on your site
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            When an AI agent reaches your page, it sees this overlay instead of your content.
          </p>

          {/* Mockup window */}
          <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--color-cream-200)] bg-[var(--color-cream-100)]">
            {/* Browser chrome */}
            <div className="flex items-center gap-2 border-b border-[var(--color-cream-200)] bg-white px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-rose)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-yellow)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-mint)]" />
              <span className="ml-3 flex-1 rounded-full bg-[var(--color-cream-100)] px-3 py-1 font-mono text-xs text-[var(--color-ink-500)]">
                {user.domain ?? ''}/article
              </span>
            </div>

            {/* Blurred content area */}
            <div className="relative px-6 py-10">
              {/* Faux blurred content */}
              <div className="space-y-3 blur-sm select-none" aria-hidden>
                <div className="h-4 w-3/4 rounded-full bg-[var(--color-ink-300)]/40" />
                <div className="h-4 w-full rounded-full bg-[var(--color-ink-300)]/30" />
                <div className="h-4 w-5/6 rounded-full bg-[var(--color-ink-300)]/30" />
                <div className="h-4 w-full rounded-full bg-[var(--color-ink-300)]/20" />
                <div className="h-4 w-2/3 rounded-full bg-[var(--color-ink-300)]/20" />
              </div>

              {/* Paywall overlay */}
              <div className="absolute inset-0 flex items-center justify-center px-4">
                <div className="w-full max-w-sm rounded-2xl border border-[var(--color-cream-200)] bg-white p-6 shadow-xl">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
                      <Zap size={18} />
                    </span>
                    <div>
                      <p className="font-semibold tracking-tight">AI Agent Access Required</p>
                      <p className="text-xs text-[var(--color-ink-500)]">
                        Powered by x402 · Stellar network
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-2 rounded-xl bg-[var(--color-cream-50)] p-4 font-mono text-xs text-[var(--color-ink-700)]">
                    <div className="flex justify-between">
                      <span className="text-[var(--color-ink-500)]">Agent pays</span>
                      <span className="font-semibold">
                        {user.pricePerRequest.toFixed(4)} USDC
                      </span>
                    </div>
                    <div className="flex justify-between text-[var(--color-stellar-mint-700,#0a7a5a)]">
                      <span className="text-[var(--color-ink-500)]">↳ You receive</span>
                      <span className="font-semibold">
                        {(user.pricePerRequest - (user.platformFee ?? 0.001)).toFixed(4)} USDC
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-ink-500)]">↳ Platform fee</span>
                      <span>{(user.platformFee ?? 0.001).toFixed(4)} USDC</span>
                    </div>
                    <div className="my-1 border-t border-[var(--color-cream-200)]" />
                    <div className="flex justify-between">
                      <span className="text-[var(--color-ink-500)]">Network</span>
                      <span>Stellar testnet</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-ink-500)]">Destination</span>
                      <span>
                        {(user.stellar_address ?? '').slice(0, 6)}…{(user.stellar_address ?? '').slice(-4)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl bg-[var(--color-cream-100)] px-4 py-3 text-center font-mono text-xs text-[var(--color-ink-500)]">
                    HTTP/1.1{' '}
                    <span className="font-semibold text-[var(--color-stellar-rose)]">
                      402 Payment Required
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-[var(--color-ink-500)]">
            Human visitors never see this overlay — they pass through to your content
            automatically.
          </p>
        </section>

        {/* WordPress plugin — server-level blocking */}
        <section className="surface-card mt-8 p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Server size={18} /> WordPress? Block at the server too
              </h2>
              <p className="mt-1 max-w-xl text-sm text-[var(--color-ink-500)]">
                The script tag stops JS-rendering bots. For full coverage — including{' '}
                <span className="font-mono text-xs">curl</span>, ChatGPT and other raw HTTP
                scrapers — install the WordPress plugin. It enforces the 402 paywall on the
                server before any HTML leaves your site. Humans still pass through automatically.
              </p>
            </div>
            <a
              href="/verivyx-paywall.zip"
              download
              className="btn-primary shrink-0 text-sm"
            >
              <Download size={14} /> Download plugin
            </a>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Upload & activate',
                body: 'WordPress Admin → Plugins → Add New → Upload Plugin → choose the ZIP, then Activate. That’s it.',
              },
              {
                step: '02',
                title: 'Zero config',
                body: 'No keys, no IDs. The plugin auto-detects your domain and points at Verivyx on activation. (Optional: Settings → Verivyx to choose which content to protect.)',
              },
              {
                step: '03',
                title: 'Done — raw HTTP pays too',
                body: 'curl, ChatGPT, and AI agents now get a 402 with payment instructions. Browsers load normally.',
              },
            ].map((s) => (
              <div key={s.step} className="rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] p-5">
                <span className="font-mono text-xs text-[var(--color-ink-300)]">{s.step}</span>
                <h3 className="mt-2 text-sm font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-xs text-[var(--color-ink-500)]">{s.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
          <div className="pointer-events-auto rounded-full bg-[var(--color-ink-900)] px-5 py-3 text-sm font-medium text-[var(--color-stellar-yellow)] shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
