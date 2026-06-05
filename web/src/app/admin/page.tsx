'use client';

import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Coins,
  RefreshCw,
  TrendingUp,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { api, type AdminStats } from '@/lib/api';

type AccentKey = 'emerald' | 'blue' | 'violet' | 'amber';

const accentClasses: Record<AccentKey, { bg: string; icon: string }> = {
  emerald: { bg: 'bg-emerald-100', icon: 'text-emerald-600' },
  blue: { bg: 'bg-blue-100', icon: 'text-blue-600' },
  violet: { bg: 'bg-violet-100', icon: 'text-violet-600' },
  amber: { bg: 'bg-amber-100', icon: 'text-amber-600' },
};

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent: AccentKey;
}) {
  const { bg, icon } = accentClasses[accent];
  return (
    <div className="surface-card surface-card-hover p-6 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          {label}
        </span>
        <div className={`flex h-9 w-9 items-center justify-center rounded-full ${bg}`}>
          <Icon size={18} className={icon} />
        </div>
      </div>
      <div>
        <div className="font-mono text-3xl font-bold text-[var(--color-ink-900)] tracking-tight">
          {value}
        </div>
        {sub && (
          <div className="mt-1 text-sm text-[var(--color-ink-500)] font-medium">{sub}</div>
        )}
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const s = await api.adminStats();
      setStats(s);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm font-medium">
          <RefreshCw size={16} className="animate-spin" />
          Loading observatory data…
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const { financial, ecosystem, traffic, topAgents } = stats;

  return (
    <div className="max-w-[1100px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-ink-900)] tracking-tight">
            Financial Hub
          </h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-500)] font-medium">
            Global performance and revenue metrics
          </p>
        </div>
        <button onClick={load} className="btn-ghost text-sm">
          <RefreshCw size={15} />
          Sync Data
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-8 flex items-start gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 border border-[var(--color-stellar-rose)]/20 px-4 py-3 text-sm text-[var(--color-stellar-rose)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="hover:opacity-70 transition-opacity">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Financial KPIs — 4 columns */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4 mb-8">
        <StatCard
          label="GMV All Time"
          value={`$${financial.gmvAllTime.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
          sub="Total volume"
          icon={Coins}
          accent="emerald"
        />
        <StatCard
          label="GMV Last 7d"
          value={`$${financial.gmv7d.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
          sub="Last 7 days"
          icon={TrendingUp}
          accent="blue"
        />
        <StatCard
          label="Profit All Time"
          value={`$${financial.platformProfitAllTime.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
          sub="Net earnings"
          icon={BarChart3}
          accent="violet"
        />
        <StatCard
          label="Profit 7d"
          value={`$${financial.platformProfit7d.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}
          sub="Last 7 days"
          icon={Zap}
          accent="amber"
        />
      </div>

      {/* Ecosystem + Traffic — 2 columns */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 mb-8">
        {/* Ecosystem Growth */}
        <div className="surface-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-100">
              <Users size={18} className="text-violet-600" />
            </div>
            <span className="text-base font-semibold text-[var(--color-ink-900)]">
              Ecosystem Growth
            </span>
          </div>
          <div className="grid grid-cols-3 gap-6">
            {[
              { label: 'Total Users', value: ecosystem.totalCreators },
              { label: 'Active 7d', value: ecosystem.activeCreators7d },
              { label: 'New 7d', value: ecosystem.newCreators7d },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="font-mono text-2xl font-bold text-[var(--color-ink-900)]">
                  {value}
                </div>
                <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-500)]">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Network Activity */}
        <div className="surface-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100">
              <Activity size={18} className="text-blue-600" />
            </div>
            <span className="text-base font-semibold text-[var(--color-ink-900)]">
              Network Activity (7d)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-6">
            {[
              { label: 'Verified', value: traffic.paymentsVerified7d, colorClass: 'text-emerald-600' },
              { label: 'Humans', value: traffic.humansServed7d, colorClass: 'text-blue-600' },
              { label: 'Bots Blocked', value: traffic.botsBlocked7d, colorClass: 'text-red-500' },
              { label: 'Anomalies', value: traffic.powAnomalies7d, colorClass: 'text-amber-600' },
            ].map(({ label, value, colorClass }) => (
              <div key={label}>
                <div className={`font-mono text-2xl font-bold ${colorClass}`}>{value}</div>
                <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-500)]">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top Agents table */}
      <div className="surface-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100">
            <Bot size={18} className="text-amber-600" />
          </div>
          <span className="text-base font-semibold text-[var(--color-ink-900)]">
            Revenue by AI Agent
          </span>
        </div>
        {topAgents.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-500)] text-center py-8">
            No agent activity recorded.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  <th className="pb-3">Agent Profile</th>
                  <th className="pb-3 text-right">Intercepts</th>
                  <th className="pb-3 text-right">Gross Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topAgents.map((a, i) => (
                  <tr
                    key={i}
                    className="border-b border-[var(--color-cream-200)]/70 last:border-0 text-sm"
                  >
                    <td className="py-4">
                      <div className="font-semibold text-[var(--color-ink-900)]">
                        {a.agent ?? 'Legacy Crawler'}
                      </div>
                      {a.category && (
                        <div className="mt-0.5 text-xs text-[var(--color-ink-500)]">
                          {a.category}
                        </div>
                      )}
                    </td>
                    <td className="py-4 text-right font-mono text-[var(--color-ink-500)]">
                      {a.intercepts.toLocaleString()}
                    </td>
                    <td className="py-4 text-right font-mono font-semibold text-emerald-600">
                      ${a.revenue.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* PoW anomaly banner */}
      {traffic.powAnomalies7d > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 mt-0.5">
            <AlertTriangle size={13} className="text-white" />
          </div>
          <p className="text-sm text-amber-800">
            <strong className="font-bold">{traffic.powAnomalies7d} Anomalies Found.</strong>{' '}
            Unusual PoW solve speeds detected. Investigate potential replay attacks.
          </p>
        </div>
      )}
    </div>
  );
}
