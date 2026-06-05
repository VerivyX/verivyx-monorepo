'use client';

import { Ban, Check, Loader2, Lock } from 'lucide-react';

export type Probe = {
  url: string;
  method: string;
  phase: 'checking' | 'blocked' | 'allowed' | 'error';
  status?: number;
  error?: string;
};

// Visualizes an UNPAID access attempt: GET demo → 402 → blocked. This is what a
// bot or scraper sees without paying — the contrast to a settled PaymentTrace.
export function AccessProbe({ probe }: { probe: Probe }) {
  const checking = probe.phase === 'checking';
  const blocked = probe.phase === 'blocked';
  const error = probe.phase === 'error';

  return (
    <div className="surface-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-cream-200)] px-4 py-2.5">
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          access check · no payment
        </span>
        <span className="tag-chip">unpaid</span>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-mint)]">
            <Check size={12} strokeWidth={3} className="text-[var(--color-ink-900)]" />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-[var(--color-ink-900)]">{probe.method} demo resource (no payment)</p>
            <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-ink-500)]">{probe.url}</p>
          </div>
        </div>

        {checking ? (
          <div className="flex items-center gap-3">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow)]">
              <Loader2 size={12} className="animate-spin text-[var(--color-ink-900)]" />
            </span>
            <p className="text-sm text-[var(--color-ink-900)]">Requesting without payment…</p>
          </div>
        ) : blocked ? (
          <>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-rose)]">
                <Lock size={12} className="text-white" />
              </span>
              <div>
                <p className="text-sm font-medium text-[var(--color-ink-900)]">
                  HTTP {probe.status ?? 402} Payment Required — access blocked
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-500)]">
                  No content returned. This is exactly what an unpaid bot or scraper receives.
                </p>
              </div>
            </div>
          </>
        ) : error ? (
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-rose)]">
              <Ban size={12} className="text-white" />
            </span>
            <p className="text-sm text-[var(--color-stellar-rose)]">{probe.error ?? 'Check failed'}</p>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow)]">
              <Check size={12} strokeWidth={3} className="text-[var(--color-ink-900)]" />
            </span>
            <p className="text-sm text-[var(--color-ink-900)]">
              Returned HTTP {probe.status} without payment.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
