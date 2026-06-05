'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, ReceiptText, RefreshCw, X } from 'lucide-react';
import { api, railLabel, stellarExpertTx, type AdminTxRecord } from '@/lib/api';

function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function HashLink({ hash, network, label }: { hash: string | null; network: string | null; label: string }) {
  if (!hash) return <span className="text-[var(--color-ink-300)]">—</span>;
  return (
    <a
      href={stellarExpertTx(hash, network)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label}: ${hash}`}
      className="inline-flex items-center gap-1 font-mono text-xs text-indigo-600 hover:underline"
    >
      {shortHash(hash)} <ExternalLink size={11} />
    </a>
  );
}

export default function AdminTransactionsPage() {
  const [rows, setRows] = useState<AdminTxRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');

  const load = useCallback(
    async (reset = true) => {
      setRefreshing(true);
      setError(null);
      try {
        const page = await api.adminTransactions({
          limit: 50,
          cursor: reset ? undefined : cursor ?? undefined,
          domain: domain.trim() || undefined,
        });
        setRows((prev) => (reset ? page.transactions : [...prev, ...page.transactions]));
        setCursor(page.nextCursor);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load transactions');
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [cursor, domain],
  );

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPlatform = rows.reduce((s, e) => s + (e.platformAmountUsdc ?? 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm font-medium">
          <RefreshCw size={16} className="animate-spin" /> Loading transactions…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-ink-900)] tracking-tight">Transactions</h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-500)] font-medium">
            Every settled payment across the ecosystem, with on-chain proof. Platform fee shown is the
            recorded per-transaction cut.
          </p>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} className="btn-ghost text-sm shrink-0">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-8 flex items-start gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 border border-[var(--color-stellar-rose)]/20 px-4 py-3 text-sm text-[var(--color-stellar-rose)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(true); }}
          placeholder="Filter by domain…"
          className="input-field max-w-xs"
        />
        <button onClick={() => load(true)} className="btn-ghost text-sm">Apply</button>
        {rows.length > 0 && (
          <span className="ml-auto text-xs font-medium text-[var(--color-ink-500)]">
            Loaded {rows.length} · platform fee Σ{' '}
            <span className="font-mono text-emerald-600">${totalPlatform.toFixed(4)}</span>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="surface-card flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cream-200)]">
            <ReceiptText size={24} className="text-[var(--color-ink-300)]" />
          </div>
          <p className="text-base font-semibold text-[var(--color-ink-900)]">No transactions yet</p>
        </div>
      ) : (
        <div className="surface-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b-2 border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  <th className="px-6 py-4">Time</th>
                  <th className="px-4 py-4">Domain / Agent</th>
                  <th className="px-4 py-4 text-right">Paid</th>
                  <th className="px-4 py-4 text-right">Creator</th>
                  <th className="px-4 py-4 text-right">Platform</th>
                  <th className="px-4 py-4">Rail</th>
                  <th className="px-4 py-4">Transfer</th>
                  <th className="px-6 py-4">Distribute</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-[var(--color-cream-200)]/70 hover:bg-[var(--color-cream-50)]">
                    <td className="px-6 py-4 font-mono text-xs text-[var(--color-ink-500)]">{fmtTime(e.createdAt)}</td>
                    <td className="px-4 py-4">
                      <div className="font-semibold">{e.domain}</div>
                      <div className="text-xs text-[var(--color-ink-500)]">{e.agent ?? 'Unknown'}</div>
                    </td>
                    <td className="px-4 py-4 text-right font-mono">${e.amountUsdc.toFixed(4)}</td>
                    <td className="px-4 py-4 text-right font-mono text-[var(--color-ink-500)]">
                      {e.creatorAmountUsdc != null ? `$${e.creatorAmountUsdc.toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-4 text-right font-mono font-semibold text-emerald-600">
                      {e.platformAmountUsdc != null ? `$${e.platformAmountUsdc.toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-4">
                      <span className="tag-chip text-[11px]">{railLabel(e.asset)}</span>
                    </td>
                    <td className="px-4 py-4">
                      <HashLink hash={e.txHash} network={e.network} label="Transfer" />
                    </td>
                    <td className="px-6 py-4">
                      <HashLink hash={e.distributeTransaction} network={e.network} label="Distribute" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor != null && (
            <div className="border-t border-[var(--color-cream-200)] py-4 text-center">
              <button onClick={() => load(false)} disabled={refreshing} className="btn-ghost text-sm">
                {refreshing ? <RefreshCw size={14} className="animate-spin" /> : null} Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
