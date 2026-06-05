'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, RefreshCw, ScrollText, X } from 'lucide-react';
import { api, type AdminLog } from '@/lib/api';

function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoString));
}

const ACTION_COLORS: Record<string, { bg: string; text: string }> = {
  UPDATE_CREATOR: { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  CREATE_CREATOR: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  DELETE_CREATOR: { bg: 'bg-red-100', text: 'text-red-600' },
  TOGGLE_PAYWALL: { bg: 'bg-amber-100', text: 'text-amber-700' },
  ADMIN_LOGIN: { bg: 'bg-violet-100', text: 'text-violet-700' },
};

function ActionBadge({ action }: { action: string }) {
  const style = ACTION_COLORS[action] ?? { bg: 'bg-[var(--color-cream-200)]', text: 'text-[var(--color-ink-700)]' };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {action}
    </span>
  );
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AdminLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('All');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { logs: data } = await api.adminLogs();
      // Sorted newest first
      const sorted = [...data].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setLogs(sorted);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  const filteredLogs =
    actionFilter === 'All' ? logs : logs.filter((l) => l.action === actionFilter);

  const knownActions = Array.from(new Set(logs.map((l) => l.action)));
  const filterOptions = ['All', ...knownActions];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm font-medium">
          <RefreshCw size={16} className="animate-spin" />
          Loading audit logs…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[900px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold text-[var(--color-ink-900)] tracking-tight">
            Audit Logs
          </h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-500)] font-medium">
            All administrative actions — sorted newest first · auto-refreshes every 30s
          </p>
        </div>
        <button onClick={load} className="btn-ghost text-sm shrink-0">
          <RefreshCw size={15} />
          Refresh
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

      {/* Action type filter */}
      {logs.length > 0 && (
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          {filterOptions.map((opt) => (
            <button
              key={opt}
              onClick={() => setActionFilter(opt)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                actionFilter === opt
                  ? 'border-indigo-600 bg-indigo-600 text-white'
                  : 'border-[var(--color-cream-200)] bg-[var(--color-cream-100)] text-[var(--color-ink-700)] hover:bg-[var(--color-cream-200)]'
              }`}
            >
              {opt === 'All' ? `All (${logs.length})` : opt}
            </button>
          ))}
        </div>
      )}

      {/* Log entries */}
      {filteredLogs.length === 0 ? (
        <div className="surface-card flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-cream-200)]">
            <ScrollText size={24} className="text-[var(--color-ink-300)]" />
          </div>
          <div>
            <p className="text-base font-semibold text-[var(--color-ink-900)]">
              No audit entries yet
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              Administrative actions will appear here once recorded.
            </p>
          </div>
        </div>
      ) : (
        <div className="surface-card overflow-hidden">
          <ul className="divide-y divide-[var(--color-cream-200)]/80">
            {filteredLogs.map((log) => (
              <li key={log.id} className="px-6 py-5 hover:bg-[var(--color-cream-50)] transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Action badge + admin email */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <ActionBadge action={log.action} />
                      <span className="text-sm font-medium text-[var(--color-ink-700)]">
                        {log.adminEmail}
                      </span>
                    </div>

                    {/* Target */}
                    {log.target && (
                      <p className="mt-1.5 text-xs text-[var(--color-ink-500)]">
                        Target:{' '}
                        <span className="font-semibold text-[var(--color-ink-700)]">
                          {log.target}
                        </span>
                      </p>
                    )}

                    {/* Metadata */}
                    {log.metadata && (
                      <details className="mt-2">
                        <summary className="text-xs text-[var(--color-ink-500)] cursor-pointer hover:text-[var(--color-ink-700)] transition-colors select-none">
                          Metadata
                        </summary>
                        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-[var(--color-cream-100)] px-3 py-2 font-mono text-[11px] text-[var(--color-ink-700)] max-h-40">
                          {JSON.stringify(log.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>

                  {/* Timestamp */}
                  <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                    <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-ink-500)]">
                      <Clock size={11} />
                      {timeAgo(log.createdAt)}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--color-ink-300)]">
                      {new Intl.DateTimeFormat(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(new Date(log.createdAt))}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
