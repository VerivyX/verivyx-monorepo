'use client';

import type { ReactNode } from 'react';
import { ArrowUpRight, Check, CircleAlert, Loader2 } from 'lucide-react';
import { testnetTxLink } from '@/lib/playground';

export type Trace = {
  url: string;
  method: string;
  phase: 'fetching' | 'settled' | 'failed';
  paymentMade?: boolean;
  status?: number;
  transaction?: string;
  amount?: string;
  error?: string;
};

function StepRow({
  label,
  state,
  children,
}: {
  label: string;
  state: 'done' | 'active' | 'idle' | 'error';
  children?: ReactNode;
}) {
  const dot =
    state === 'done' ? (
      <Check size={12} strokeWidth={3} className="text-[var(--color-ink-900)]" />
    ) : state === 'error' ? (
      <CircleAlert size={12} className="text-white" />
    ) : state === 'active' ? (
      <Loader2 size={12} className="animate-spin text-[var(--color-ink-900)]" />
    ) : null;

  const dotBg =
    state === 'done'
      ? 'bg-[var(--color-stellar-mint)]'
      : state === 'error'
        ? 'bg-[var(--color-stellar-rose)]'
        : state === 'active'
          ? 'bg-[var(--color-stellar-yellow)]'
          : 'bg-[var(--color-cream-200)]';

  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${dotBg}`}>
        {dot}
      </span>
      <div className="min-w-0">
        <p
          className={`text-sm ${
            state === 'idle' ? 'text-[var(--color-ink-300)]' : 'text-[var(--color-ink-900)]'
          }`}
        >
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}

// Visualizes a single x402 settlement: 402 → sign → settle on Stellar.
export function PaymentTrace({ trace }: { trace: Trace }) {
  const fetching = trace.phase === 'fetching';
  const failed = trace.phase === 'failed';
  const settled = trace.phase === 'settled' && trace.paymentMade;

  return (
    <div className="surface-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-cream-200)] px-4 py-2.5">
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          x402 payment trace
        </span>
        <span className="tag-chip">stellar:testnet</span>
      </div>

      <div className="space-y-4 p-4">
        <StepRow label={`${trace.method} demo resource`} state="done">
          <p className="mt-0.5 break-all font-mono text-xs text-[var(--color-ink-500)]">
            {trace.url}
          </p>
        </StepRow>

        <StepRow
          label="HTTP 402 Payment Required"
          state={failed && !trace.paymentMade ? 'error' : 'done'}
        />

        <StepRow
          label="Signed USDC payment over x402"
          state={fetching ? 'active' : failed && !settled ? 'error' : 'done'}
        />

        {settled ? (
          <StepRow label="Settled on Stellar testnet" state="done">
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {trace.amount ? (
                <span className="rounded-md bg-[var(--color-stellar-yellow-soft)] px-2 py-0.5 font-mono text-xs text-[var(--color-ink-900)]">
                  {trace.amount} USDC
                </span>
              ) : null}
              {trace.transaction ? (
                <a
                  href={testnetTxLink(trace.transaction)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-[var(--color-stellar-violet)] hover:underline"
                >
                  {trace.transaction.slice(0, 10)}…{trace.transaction.slice(-6)}
                  <ArrowUpRight size={12} />
                </a>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-[var(--color-ink-500)]">
              Split on-chain between the demo creator and the platform via{' '}
              <span className="font-mono">distribute()</span>.
            </p>
          </StepRow>
        ) : failed ? (
          <StepRow label="Payment failed" state="error">
            {trace.error ? (
              <p className="mt-0.5 text-xs text-[var(--color-stellar-rose)]">{trace.error}</p>
            ) : null}
          </StepRow>
        ) : (
          <StepRow label="Settling on Stellar testnet…" state="active" />
        )}
      </div>
    </div>
  );
}
