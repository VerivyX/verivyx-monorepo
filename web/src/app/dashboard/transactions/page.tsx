'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, ExternalLink, LogOut, ReceiptText, RefreshCw, X } from 'lucide-react';
import {
  api,
  clearSession,
  getStoredUser,
  railLabel,
  stellarExpertTx,
  type CreatorUser,
  type TxRecord,
} from '@/lib/api';

function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function HashLink({ hash, network, label }: { hash: string | null; network: string | null; label: string }) {
  if (!hash) return <span className="text-[var(--color-ink-300)]">—</span>;
  return (
    <a
      href={stellarExpertTx(hash, network)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label}: ${hash}`}
      className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-stellar-violet)] hover:underline"
    >
      {shortHash(hash)} <ExternalLink size={11} />
    </a>
  );
}

export default function CreatorTransactionsPage() {
  const router = useRouter();
  const [user, setUser] = useState<CreatorUser | null>(null);
  const [rows, setRows] = useState<TxRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset = true) => {
      setRefreshing(true);
      setError(null);
      try {
        const meRes = await api.me();
        if (meRes.user.needsOnboarding) { router.replace('/onboarding'); return; }
        setUser(meRes.user);
        const page = await api.creatorTransactions({ limit: 50, cursor: reset ? undefined : cursor ?? undefined });
        setRows((prev) => (reset ? page.transactions : [...prev, ...page.transactions]));
        setCursor(page.nextCursor);
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
    },
    [router, cursor],
  );

  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) {
      router.replace('/login');
      return;
    }
    setUser(stored);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Loading transactions…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-cream-50)]">
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="btn-ghost text-sm">
              <ArrowLeft size={14} /> Dashboard
            </Link>
            <span className="text-sm text-[var(--color-ink-500)]">/</span>
            <p className="text-sm font-semibold tracking-tight">Transactions</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => load(true)} disabled={refreshing} className="btn-ghost text-sm">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={() => {
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

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Domain · <span className="font-mono normal-case tracking-normal">{user.domain ?? ''}</span>
          </p>
          <h1 className="mt-2 flex items-center gap-2 text-3xl font-semibold tracking-tight md:text-4xl">
            <ReceiptText size={28} /> Transactions
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-[var(--color-ink-500)]">
            Every settled AI payment, with on-chain proof. The transfer hash is the agent paying the
            paywall contract; the distribute hash is the contract splitting your share and the platform
            fee — both verifiable on Stellar.
          </p>
        </div>

        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="hover:opacity-80">
              <X size={14} />
            </button>
          </div>
        )}

        <section className="surface-card mt-8 p-6">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-[var(--color-ink-500)]">
              No settled payments yet. When an AI agent pays your paywall, it shows up here with full
              on-chain proof.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    <th className="pb-3">Time</th>
                    <th className="pb-3">Agent</th>
                    <th className="pb-3 text-right">Agent pays</th>
                    <th className="pb-3 text-right">You receive</th>
                    <th className="pb-3 text-right">Platform fee</th>
                    <th className="pb-3">Rail</th>
                    <th className="pb-3">Transfer</th>
                    <th className="pb-3">Distribute</th>
                    <th className="pb-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--color-cream-200)]/70 text-sm">
                      <td className="py-4 font-mono text-xs text-[var(--color-ink-500)]">{fmtTime(e.createdAt)}</td>
                      <td className="py-4">
                        <div className="font-medium">{e.agent ?? 'Unknown'}</div>
                        {e.category && <span className="tag-chip mt-1 text-[11px]">{e.category}</span>}
                      </td>
                      <td className="py-4 text-right font-mono">${e.amountUsdc.toFixed(4)}</td>
                      <td className="py-4 text-right font-mono text-emerald-600">
                        {e.creatorAmountUsdc != null ? `$${e.creatorAmountUsdc.toFixed(4)}` : '—'}
                      </td>
                      <td className="py-4 text-right font-mono text-[var(--color-ink-500)]">
                        {e.platformAmountUsdc != null ? `$${e.platformAmountUsdc.toFixed(4)}` : '—'}
                      </td>
                      <td className="py-4">
                        <span className="tag-chip text-[11px]">{railLabel(e.asset)}</span>
                      </td>
                      <td className="py-4">
                        <HashLink hash={e.txHash} network={e.network} label="Transfer" />
                      </td>
                      <td className="py-4">
                        <HashLink hash={e.distributeTransaction} network={e.network} label="Distribute" />
                      </td>
                      <td className="py-4">
                        <span className="tag-chip text-[11px] capitalize">{e.status ?? 'confirmed'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {cursor != null && (
                <div className="mt-6 text-center">
                  <button onClick={() => load(false)} disabled={refreshing} className="btn-ghost text-sm">
                    {refreshing ? <RefreshCw size={14} className="animate-spin" /> : null} Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
