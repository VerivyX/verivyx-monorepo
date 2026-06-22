'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Bot,
  Coins,
  Fingerprint,
  Globe,
  LogOut,
  Pencil,
  ReceiptText,
  RefreshCw,
  Settings2,
  Shield,
  Sparkles,
  Terminal,
  Timer,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import {
  api,
  clearSession,
  getStoredUser,
  normalizeDomain,
  STELLAR_PUBKEY_REGEX,
  type AnalyticsResponse,
  type CreatorUser,
} from '@/lib/api';
import PayoutCard from '@/components/PayoutCard';
import { LogoMark } from '@/components/Logo';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<CreatorUser | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [pendingPrice, setPendingPrice] = useState<number | null>(null);
  const [savingPrice, setSavingPrice] = useState(false);
  const [togglePending, setTogglePending] = useState(false);

  const [editingDomain, setEditingDomain] = useState(false);
  const [domainDraft, setDomainDraft] = useState('');
  const [savingDomain, setSavingDomain] = useState(false);

  const [editingWallet, setEditingWallet] = useState(false);
  const [walletDraft, setWalletDraft] = useState('');
  const [savingWallet, setSavingWallet] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const meRes = await api.me();
      if (meRes.user.needsOnboarding) {
        router.replace('/onboarding');
        return;
      }
      const analyticsRes = await api.analytics();
      setUser(meRes.user);
      setAnalytics(analyticsRes);
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
    refresh();
  }, [router, refresh]);

  const handleLogout = () => {
    clearSession();
    router.push('/');
  };

  const handleSavePrice = async () => {
    if (pendingPrice === null || !user) return;
    setSavingPrice(true);
    try {
      const data = await api.updateSettings({ pricePerRequest: pendingPrice });
      setUser(data.user);
      setPendingPrice(null);
      showToast(`Price updated to $${data.user.pricePerRequest.toFixed(4)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSavingPrice(false);
    }
  };

  const handleTogglePaywall = async (next: boolean) => {
    if (!user || togglePending) return;
    setTogglePending(true);
    setError(null);
    try {
      const data = await api.updateSettings({ paywallEnabled: next });
      setUser(data.user);
      showToast(next ? 'Paywall enabled' : 'Paywall paused — agents flow free');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setTogglePending(false);
    }
  };

  const handleStartEditDomain = () => {
    if (!user) return;
    setDomainDraft(user.domain ?? '');
    setEditingDomain(true);
  };

  const handleSaveDomain = async () => {
    if (!user) return;
    const cleaned = normalizeDomain(domainDraft);
    if (!cleaned) {
      setError('Domain must look like example.com (lowercase, with a TLD).');
      return;
    }
    setSavingDomain(true);
    setError(null);
    try {
      const data = await api.updateSettings({ domain: cleaned });
      setUser(data.user);
      setEditingDomain(false);
      showToast(`Domain updated to ${cleaned}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Domain update failed');
    } finally {
      setSavingDomain(false);
    }
  };

  const handleStartEditWallet = () => {
    if (!user) return;
    setWalletDraft(user.stellar_address ?? '');
    setEditingWallet(true);
  };

  const handleSaveWallet = async () => {
    if (!user) return;
    const v = walletDraft.trim();
    if (!STELLAR_PUBKEY_REGEX.test(v)) {
      setError('Stellar public key must start with G and be 56 chars.');
      return;
    }
    setSavingWallet(true);
    setError(null);
    try {
      const data = await api.updateSettings({ stellar_address: v });
      setUser(data.user);
      setEditingWallet(false);
      showToast('Stellar wallet updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet update failed');
    } finally {
      setSavingWallet(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Loading dashboard…
        </div>
      </div>
    );
  }

  const totals = analytics?.totals;
  const currentPrice = pendingPrice ?? user.pricePerRequest;
  const paywallOn = user.paywallEnabled;

  return (
    <div className="min-h-screen bg-[var(--color-cream-50)]">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <LogoMark size={32} />
            <div>
              <p className="text-sm font-semibold tracking-tight">Verivyx</p>
              <p className="text-xs text-[var(--color-ink-500)]">Creator dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <PaywallStatusPill enabled={paywallOn} />
            <Link href="/dashboard/script" className="btn-yellow text-sm">
              <Zap size={14} /> Get Script
            </Link>
            <Link href="/dashboard/transactions" className="btn-ghost text-sm">
              <ReceiptText size={14} /> Transactions
            </Link>
            <Link href="/dashboard/test" className="btn-ghost text-sm">
              <Terminal size={14} /> Test
            </Link>
            <Link href="/mcp/wallet" className="btn-ghost text-sm">
              <Wallet size={14} /> Agent Wallet
            </Link>
            {user?.role === 'ADMIN' && (
              <Link href="/admin" className="btn-ghost text-sm" style={{ color: '#a78bfa' }}>
                <Shield size={14} /> Admin
              </Link>
            )}
            <button onClick={refresh} disabled={refreshing} className="btn-ghost text-sm">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <button onClick={handleLogout} className="btn-primary text-sm">
              <LogOut size={14} /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {/* Welcome */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Welcome back
          </p>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{user.email}</h1>
          <p className="text-sm text-[var(--color-ink-500)]">
            Domain · <span className="font-mono">{user.domain ?? '—'}</span> · Wallet{' '}
            <span className="font-mono">
              {(user.stellar_address ?? '').slice(0, 6)}…{(user.stellar_address ?? '').slice(-4)}
            </span>
          </p>
        </div>

        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-[var(--color-stellar-rose)] hover:opacity-80">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Master toggle */}
        <section
          className={`mt-8 flex flex-col gap-4 rounded-3xl border p-6 md:flex-row md:items-center md:justify-between md:p-8 ${
            paywallOn
              ? 'border-[var(--color-cream-200)] bg-white'
              : 'border-[var(--color-stellar-rose)]/20 bg-[var(--color-stellar-rose)]/5'
          }`}
        >
          <div className="flex items-start gap-4">
            <span
              className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${
                paywallOn
                  ? 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]'
                  : 'bg-[var(--color-stellar-rose)]/15 text-[var(--color-stellar-rose)]'
              }`}
            >
              {paywallOn ? <Sparkles size={20} /> : <AlertTriangle size={20} />}
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight md:text-xl">
                {paywallOn ? 'Paywall is live' : 'Paywall is paused'}
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-[var(--color-ink-500)]">
                {paywallOn
                  ? 'AI agents that hit your origin must settle a USDC micropayment via Stellar before they see content. Humans pass through unchanged.'
                  : 'All traffic — including AI agents — currently passes through to your content. Your embed script stays in place; flip the switch back any time.'}
              </p>
            </div>
          </div>
          <ToggleSwitch
            checked={paywallOn}
            disabled={togglePending}
            onChange={(v) => handleTogglePaywall(v)}
            ariaLabel="Toggle paywall"
          />
        </section>

        {/* KPIs */}
        <section className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            icon={<Coins size={18} />}
            label="USDC earned · 7d"
            value={`$${(totals?.earnedUsdc ?? 0).toFixed(4)}`}
            sub={
              totals && totals.earnedDeltaPct !== 0
                ? `${totals.earnedDeltaPct > 0 ? '↑' : '↓'} ${Math.abs(totals.earnedDeltaPct)}% vs prior week`
                : 'No prior data yet'
            }
            accent="yellow"
          />
          <KpiCard
            icon={<Bot size={18} />}
            label="Bots blocked · 7d"
            value={(totals?.botsBlocked ?? 0).toLocaleString()}
            sub={`${totals?.paymentsVerified ?? 0} paid through`}
            accent="violet"
          />
          <KpiCard
            icon={<Activity size={18} />}
            label="Humans served · 7d"
            value={(totals?.humansServed ?? 0).toLocaleString()}
            sub={`${totals?.humansFailed ?? 0} failed challenges`}
            accent="mint"
          />
          <KpiCard
            icon={<Zap size={18} />}
            label="PoW anomalies · 7d"
            value={(totals?.powAnomalies7d ?? 0).toLocaleString()}
            sub="Solved suspiciously fast"
            accent="rose"
          />
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
          {/* Left column: USDC wallet status + Embed/Settings */}
          <div className="flex flex-col gap-6 xl:col-span-1">
            <PayoutCard />
            <div className="surface-card p-6">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Settings2 size={18} /> Embed & pricing
              </h2>
            </div>

            {/* Domain */}
            <div className="mt-6 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                <Globe size={12} /> Domain
              </label>
              {editingDomain ? (
                <div className="flex flex-col gap-2">
                  <input
                    autoFocus
                    className="input-field font-mono"
                    placeholder="my-blog.com"
                    value={domainDraft}
                    onChange={(e) => setDomainDraft(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveDomain}
                      disabled={savingDomain}
                      className="btn-yellow text-xs disabled:opacity-60"
                    >
                      {savingDomain ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingDomain(false)}
                      className="btn-ghost text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input className="input-field font-mono" value={user.domain ?? ''} readOnly />
                  <button
                    onClick={handleStartEditDomain}
                    className="btn-ghost px-3 py-2 text-xs"
                    aria-label="Edit domain"
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              )}
            </div>

            {/* Wallet */}
            <div className="mt-5 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                <Wallet size={12} /> Stellar address
              </label>
              {editingWallet ? (
                <div className="flex flex-col gap-2">
                  <input
                    autoFocus
                    className="input-field font-mono text-xs"
                    placeholder="G…"
                    value={walletDraft}
                    onChange={(e) => setWalletDraft(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveWallet}
                      disabled={savingWallet}
                      className="btn-yellow text-xs disabled:opacity-60"
                    >
                      {savingWallet ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingWallet(false)}
                      className="btn-ghost text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    className="input-field font-mono text-xs"
                    value={user.stellar_address ?? ''}
                    readOnly
                  />
                  <button
                    onClick={handleStartEditWallet}
                    className="btn-ghost px-3 py-2 text-xs"
                    aria-label="Edit wallet"
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              )}
            </div>

            {/* Price */}
            <div className="mt-5 flex flex-col gap-2">
              <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                <span className="flex items-center gap-2">
                  <Coins size={12} /> Price per AI request
                </span>
                <span className="font-mono normal-case tracking-normal text-[var(--color-ink-900)]">
                  ${currentPrice.toFixed(4)} USDC
                </span>
              </label>
              <input
                type="range"
                min="0.0005"
                max="0.05"
                step="0.0005"
                value={currentPrice}
                onChange={(e) => setPendingPrice(Number(e.target.value))}
                className="w-full accent-[var(--color-ink-900)]"
              />
              {pendingPrice !== null && pendingPrice !== user.pricePerRequest && (
                <button
                  onClick={handleSavePrice}
                  disabled={savingPrice}
                  className="btn-yellow mt-2 self-start text-sm disabled:opacity-60"
                >
                  {savingPrice ? 'Saving…' : 'Save price'}
                </button>
              )}
            </div>

            </div>
          </div>

          {/* KYA */}
          <div className="surface-card p-6 xl:col-span-2">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Bot size={18} /> Know Your Agent
                </h2>
                <p className="text-sm text-[var(--color-ink-500)]">
                  Live breakdown of which AI agents touched your content.
                </p>
              </div>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    <th className="pb-3">Agent</th>
                    <th className="pb-3">Category</th>
                    <th className="pb-3 text-right">Intercepts</th>
                    <th className="pb-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {(analytics?.agents ?? []).length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-sm text-[var(--color-ink-500)]">
                        No agent traffic yet. Drop the embed snippet, then visit your site with
                        User-Agent: <code>GPTBot</code> to see this fill in.
                      </td>
                    </tr>
                  )}
                  {(analytics?.agents ?? []).map((row, idx) => (
                    <tr key={idx} className="border-b border-[var(--color-cream-200)]/70 text-sm">
                      <td className="py-4 font-medium">{row.agent ?? 'Unknown'}</td>
                      <td className="py-4">
                        <span className="tag-chip text-[11px]">{row.category ?? '—'}</span>
                      </td>
                      <td className="py-4 text-right font-mono">
                        {row.intercepts.toLocaleString()}
                      </td>
                      <td className="py-4 text-right font-mono">${row.revenue.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-8 flex flex-col h-full">
              <h3 className="text-sm font-semibold shrink-0">Recent activity</h3>
              <div className="mt-3 overflow-y-auto max-h-72 pr-2 custom-scrollbar">
                <ul className="divide-y divide-[var(--color-cream-200)]/80">
                  {(analytics?.recent ?? []).length === 0 && (
                    <li className="py-6 text-sm text-[var(--color-ink-500)]">No events yet.</li>
                  )}
                  {(analytics?.recent ?? []).map((e) => (
                    <li key={e.id} className="flex items-center justify-between py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <EventBadge type={e.type} />
                        <div>
                          <p className="font-medium">
                            {e.agent ?? 'Unattributed'}{' '}
                            <span className="text-[var(--color-ink-500)]">
                              — {e.type.replace(/_/g, ' ')}
                            </span>
                          </p>
                          <p className="font-mono text-[11px] text-[var(--color-ink-500)]">
                            {new Date(e.createdAt).toLocaleString()}
                            {e.txHash ? ` · tx ${e.txHash.slice(0, 6)}…${e.txHash.slice(-4)}` : ''}
                            {e.powDurationMs != null ? ` · PoW ${e.powDurationMs}ms` : ''}
                            {e.ja4 ? ` · JA4 ${e.ja4.slice(0, 12)}…` : ''}
                          </p>
                        </div>
                      </div>
                      {e.amountUsdc > 0 && (
                        <span className="font-mono text-sm">+${e.amountUsdc.toFixed(4)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Security signals */}
        <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* PoW solve-time histogram */}
          <div className="surface-card p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Timer size={18} /> PoW solve-time · 7d
            </h2>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              Distribution of how long browsers took to solve the proof-of-work challenge.
            </p>
            {analytics?.powDurationBuckets ? (
              <PowHistogram buckets={analytics.powDurationBuckets} />
            ) : (
              <p className="mt-6 text-sm text-[var(--color-ink-500)]">No PoW data yet.</p>
            )}
          </div>

          {/* Top JA4 fingerprints */}
          <div className="surface-card p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Fingerprint size={18} /> Top JA4 fingerprints · 7d
            </h2>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              TLS fingerprints seen most often. Repeated identical JA4 across many IPs signals a
              headless browser farm.
            </p>
            {(analytics?.topJa4 ?? []).length === 0 ? (
              <p className="mt-6 text-sm text-[var(--color-ink-500)]">
                No JA4 data yet — requires an HTTPS-terminated reverse proxy that injects{' '}
                <code className="font-mono">X-JA4</code>.
              </p>
            ) : (
              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-[var(--color-cream-200)] text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                      <th className="pb-3">JA4 fingerprint</th>
                      <th className="pb-3 text-right">Requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(analytics?.topJa4 ?? []).map((row) => (
                      <tr key={row.ja4} className="border-b border-[var(--color-cream-200)]/70 text-sm">
                        <td className="py-3 font-mono text-[11px]">{row.ja4}</td>
                        <td className="py-3 text-right font-mono">{row.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Anomaly signals banner — only shown when anomalies exist */}
        {(totals?.powAnomalies7d ?? 0) > 0 && (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-[var(--color-stellar-rose)]/30 bg-[var(--color-stellar-rose)]/5 px-5 py-4">
            <Shield size={18} className="mt-0.5 shrink-0 text-[var(--color-stellar-rose)]" />
            <div>
              <p className="text-sm font-semibold text-[var(--color-stellar-rose)]">
                {totals!.powAnomalies7d} PoW anomaly{totals!.powAnomalies7d !== 1 ? 'ies' : ''}{' '}
                detected in the last 7 days
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                These browsers solved the challenge faster than the {' '}
                <code className="font-mono">POW_MIN_SOLVE_MS</code> threshold — a signal of
                headless automation. Their reputation tier has been downgraded; future challenges
                will use higher difficulty.
              </p>
            </div>
          </div>
        )}

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

function PaywallStatusPill({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <span className="tag-chip">
        <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-yellow)]" />
        Paywall live · Soroban Testnet
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-stellar-rose)]/30 bg-[var(--color-stellar-rose)]/10 px-3 py-1 text-xs font-semibold text-[var(--color-stellar-rose)]">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-rose)]" />
      Paywall paused
    </span>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-12 w-24 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? 'border-[var(--color-ink-900)] bg-[var(--color-ink-900)]'
          : 'border-[var(--color-cream-200)] bg-[var(--color-cream-100)]'
      }`}
    >
      <span
        className={`inline-block h-9 w-9 transform rounded-full shadow transition-transform ${
          checked
            ? 'translate-x-12 bg-[var(--color-stellar-yellow)]'
            : 'translate-x-1 bg-white'
        }`}
      />
      <span
        className={`absolute font-mono text-[10px] font-semibold uppercase tracking-widest ${
          checked
            ? 'left-3 text-[var(--color-stellar-yellow)]'
            : 'right-3 text-[var(--color-ink-500)]'
        }`}
      >
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: 'yellow' | 'violet' | 'mint' | 'rose';
}) {
  const accentBg = {
    yellow: 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]',
    violet: 'bg-[var(--color-stellar-violet-soft)] text-[var(--color-stellar-violet)]',
    mint: 'bg-[var(--color-stellar-mint)]/20 text-[var(--color-ink-900)]',
    rose: 'bg-[var(--color-stellar-rose)]/15 text-[var(--color-stellar-rose)]',
  }[accent];

  return (
    <div className="surface-card surface-card-hover p-5">
      <div className="flex items-center justify-between">
        <span className={`grid h-9 w-9 place-items-center rounded-full ${accentBg}`}>{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          {label}
        </span>
      </div>
      <p className="mt-6 font-mono text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-[var(--color-ink-500)]">{sub}</p>
    </div>
  );
}

function EventBadge({ type }: { type: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    bot_blocked: {
      bg: 'bg-[var(--color-stellar-rose)]/15 text-[var(--color-stellar-rose)]',
      label: '402',
    },
    payment_verified: {
      bg: 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]',
      label: '$',
    },
    agent_served: {
      bg: 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]',
      label: '🤖',
    },
    human_served: {
      bg: 'bg-[var(--color-stellar-mint)]/25 text-[var(--color-ink-900)]',
      label: '✓',
    },
    challenge_passed: {
      bg: 'bg-[var(--color-stellar-mint)]/25 text-[var(--color-ink-900)]',
      label: 'PoW',
    },
    challenge_failed: {
      bg: 'bg-[var(--color-stellar-rose)]/15 text-[var(--color-stellar-rose)]',
      label: '✗',
    },
    bot_passthrough: {
      bg: 'bg-[var(--color-stellar-violet-soft)] text-[var(--color-stellar-violet)]',
      label: '∼',
    },
  };
  const it = map[type] ?? {
    bg: 'bg-[var(--color-cream-200)] text-[var(--color-ink-700)]',
    label: '·',
  };
  return (
    <span
      className={`grid h-8 w-8 place-items-center rounded-full font-mono text-xs font-semibold ${it.bg}`}
    >
      {it.label}
    </span>
  );
}

function PowHistogram({
  buckets,
}: {
  buckets: { under50: number; between50_200: number; between200_500: number; over500: number };
}) {
  const bars = [
    { label: '<50ms', value: buckets.under50, accent: 'var(--color-stellar-rose)', note: 'bot signal' },
    { label: '50–200ms', value: buckets.between50_200, accent: 'var(--color-stellar-mint)', note: 'human' },
    { label: '200–500ms', value: buckets.between200_500, accent: 'var(--color-stellar-yellow)', note: 'slow device' },
    { label: '>500ms', value: buckets.over500, accent: 'var(--color-ink-500)', note: 'very slow' },
  ];
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="mt-6 flex flex-col gap-3">
      {bars.map((b) => (
        <div key={b.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-right font-mono text-[11px] text-[var(--color-ink-500)]">
            {b.label}
          </span>
          <div className="relative flex-1 overflow-hidden rounded-full bg-[var(--color-cream-200)] h-4">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(b.value / max) * 100}%`, background: b.accent }}
            />
          </div>
          <span className="w-16 shrink-0 font-mono text-[11px] text-[var(--color-ink-500)]">
            {b.value.toLocaleString()} <span className="text-[10px] opacity-60">({b.note})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

