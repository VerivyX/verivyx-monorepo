'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, LogOut, RefreshCw, X } from 'lucide-react';
import { api, clearSession, getStoredUser, type CreatorUser } from '@/lib/api';
import { EmbedPanel } from './EmbedPanel';
import { WordPressPanel } from './WordPressPanel';

type Tab = 'sdk' | 'wordpress' | 'embed';

const TABS: { id: Tab; label: string }[] = [
  { id: 'sdk', label: 'SDK' },
  { id: 'wordpress', label: 'WordPress' },
  { id: 'embed', label: 'Embed script' },
];

function isTab(v: string | null): v is Tab {
  return v === 'sdk' || v === 'wordpress' || v === 'embed';
}

function IntegrationsInner({ user, refreshing, onRefresh }: {
  user: CreatorUser;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const rawTab = params.get('tab');
  const activeTab: Tab = isTab(rawTab) ? rawTab : 'sdk';
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setTab = (tab: Tab) => {
    router.replace(`/dashboard/integrations?tab=${tab}`);
  };

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') {
      next = (index + 1) % TABS.length;
    } else if (e.key === 'ArrowLeft') {
      next = (index - 1 + TABS.length) % TABS.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = TABS.length - 1;
    }
    if (next !== null) {
      e.preventDefault();
      setTab(TABS[next].id);
      tabRefs.current[next]?.focus();
    }
  };

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
            <p className="text-sm font-semibold tracking-tight">Integrations</p>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={onRefresh} disabled={refreshing} className="btn-ghost text-sm">
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
        {/* Tab bar */}
        <div
          role="tablist"
          aria-label="Integration tabs"
          className="surface-card mb-8 inline-flex gap-1 rounded-2xl p-1.5"
        >
          {TABS.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => { tabRefs.current[index] = el; }}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setTab(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                className={[
                  'rounded-xl px-5 py-2 text-sm font-semibold transition-colors',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]',
                  isActive
                    ? 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)] shadow-sm'
                    : 'text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]',
                ].join(' ')}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab panels */}
        {activeTab === 'sdk' && (
          <div className="surface-card p-6">
            SDK setup — coming in the next step.
          </div>
        )}
        {activeTab === 'wordpress' && <WordPressPanel user={user} />}
        {activeTab === 'embed' && <EmbedPanel user={user} />}
      </main>
    </div>
  );
}

export default function IntegrationsPage() {
  const router = useRouter();
  const [user, setUser] = useState<CreatorUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const meRes = await api.me();
      if (meRes.user.needsOnboarding) { router.replace('/onboarding'); return; }
      setUser(meRes.user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load';
      if (msg.toLowerCase().includes('token')) {
        clearSession();
        router.push('/login');
      } else {
        setError(msg);
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

  if (loading || !user) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        {error ? (
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-4 py-3 text-sm text-[var(--color-stellar-rose)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-[var(--color-stellar-rose)] hover:opacity-80">
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <RefreshCw size={16} className="animate-spin" /> Loading integrations…
          </div>
        )}
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
          <div className="flex items-center gap-3 text-sm">
            <RefreshCw size={16} className="animate-spin" /> Loading…
          </div>
        </div>
      }
    >
      <IntegrationsInner user={user} refreshing={refreshing} onRefresh={load} />
    </Suspense>
  );
}
