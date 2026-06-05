'use client';

import { useCallback, useEffect, useState } from 'react';
import { Boxes, Download, RefreshCw, Wallet } from 'lucide-react';
import { api, type McpOverview, type McpWaitlistEntry } from '@/lib/api';

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function shortAddr(a?: string): string {
  if (!a) return '—';
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

export default function AdminMcpPage() {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [waitlist, setWaitlist] = useState<McpWaitlistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [ov, wl] = await Promise.allSettled([api.adminMcpOverview(), api.adminMcpWaitlist()]);
    if (ov.status === 'fulfilled') {
      setOverview(ov.value);
      setOverviewError(null);
    } else {
      setOverview(null);
      setOverviewError(ov.reason instanceof Error ? ov.reason.message : 'unreachable');
    }
    if (wl.status === 'fulfilled') {
      setWaitlist(wl.value.waitlist);
      setTotal(wl.value.total);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = useCallback(() => {
    const rows = [
      ['email', 'source', 'invited', 'createdAt'],
      ...waitlist.map((w) => [w.email, w.source, String(w.invited), w.createdAt]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mcp-waitlist.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [waitlist]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]">
            <Boxes className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold">MCP Control</h1>
            <p className="text-sm text-[var(--color-ink-500)]">Verivyx x402 MCP — chains, wallets, and waitlist.</p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-ink-200)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-ink-50)]"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Overview */}
      <section className="surface-card p-6">
        <h2 className="text-lg font-semibold">Server overview</h2>
        {overviewError ? (
          <p className="mt-3 text-sm text-amber-600">
            MCP server unreachable ({overviewError}). The service may not be running yet.
          </p>
        ) : overview ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Service fee" value={`${overview.serviceFee} USDC`} />
              <Stat label="Network mode" value={overview.mainnetEnabled ? 'Mainnet' : 'Testnet'} />
              <Stat label="API keys" value={String(overview.apiKeysConfigured)} />
              <Stat label="Chains live" value={String(overview.chains.filter((c) => c.enabled).length)} />
            </div>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-[var(--color-ink-500)]">
                  <tr>
                    <th className="py-2 pr-4">Chain</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Wallet</th>
                    <th className="py-2 pr-4">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.chains.map((c, i) => (
                    <tr key={`${c.kind}-${i}`} className="border-t border-[var(--color-ink-100)]">
                      <td className="py-2 pr-4 font-medium">{c.chain ?? c.kind}</td>
                      <td className="py-2 pr-4">
                        {c.enabled ? (
                          <span className="tag-chip bg-emerald-100 text-emerald-700">Live</span>
                        ) : (
                          <span className="tag-chip bg-[var(--color-ink-100)] text-[var(--color-ink-500)]">
                            {c.plannedPhase ?? 'Planned'}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        <span className="inline-flex items-center gap-1">
                          {c.walletAddress && <Wallet className="h-3 w-3 text-[var(--color-ink-400)]" />}
                          {shortAddr(c.walletAddress)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-[var(--color-ink-500)]">
                        {c.enabled ? (c.testnet ? 'testnet' : 'mainnet') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-ink-500)]">Loading…</p>
        )}
      </section>

      {/* Waitlist */}
      <section className="surface-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Early-access waitlist <span className="text-[var(--color-ink-400)]">({total})</span>
          </h2>
          <button
            onClick={exportCsv}
            disabled={waitlist.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-ink-200)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-ink-50)] disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </div>
        {waitlist.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-ink-500)]">No signups yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-[var(--color-ink-500)]">
                <tr>
                  <th className="py-2 pr-4">Email</th>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Joined</th>
                </tr>
              </thead>
              <tbody>
                {waitlist.map((w) => (
                  <tr key={w.id} className="border-t border-[var(--color-ink-100)]">
                    <td className="py-2 pr-4 font-medium">{w.email}</td>
                    <td className="py-2 pr-4 text-[var(--color-ink-500)]">{w.source}</td>
                    <td className="py-2 pr-4 text-[var(--color-ink-500)]">{fmtDate(w.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-ink-100)] p-4">
      <p className="text-xs uppercase text-[var(--color-ink-500)]">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
