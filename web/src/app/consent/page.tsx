'use client';

/**
 * OAuth consent screen. Hydra (via auth-service /oauth/consent) redirects the
 * logged-in user here with a consent_challenge when CONSENT_SCREEN_ENABLED is on.
 * The user explicitly approves/denies an app's access to their Verivyx wallet.
 *
 * Flow: fetch the app + scopes (oauthConsentInfo) → Allow/Deny →
 * oauthConsentAccept/Reject returns a Hydra redirect_to (external) → navigate.
 */

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Wallet, Clock, Loader2 } from 'lucide-react';
import { api, getStoredUser } from '@/lib/api';
import { Logo } from '@/components/Logo';

function ConsentInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const challenge = searchParams.get('consent_challenge');

  const [clientName, setClientName] = useState<string>('An application');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);

  useEffect(() => {
    if (!challenge) {
      setError('Missing consent challenge.');
      setLoadState('error');
      return;
    }
    if (!getStoredUser()) {
      // Not authenticated — the OAuth flow logs the user in before consent, so
      // this is an edge (e.g. opened directly). Send them to login.
      router.replace('/login');
      return;
    }
    let cancelled = false;
    api
      .oauthConsentInfo(challenge)
      .then((info) => {
        if (cancelled) return;
        setClientName(info.clientName || 'An application');
        setLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the consent request.');
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [challenge, router]);

  const decide = useCallback(
    async (allow: boolean) => {
      if (!challenge || busy) return;
      setBusy(allow ? 'allow' : 'deny');
      setError(null);
      try {
        const { redirect_to } = allow
          ? await api.oauthConsentAccept(challenge)
          : await api.oauthConsentReject(challenge);
        window.location.href = redirect_to; // external (Hydra)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
        setBusy(null);
      }
    },
    [challenge, busy],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-cream-50)] px-4 py-10">
      <div className="surface-card w-full max-w-md p-8">
        <div className="flex justify-center">
          <Logo />
        </div>

        {loadState === 'loading' && (
          <div className="mt-8 flex items-center justify-center gap-2 text-[var(--color-ink-500)]">
            <Loader2 className="animate-spin" size={18} /> Loading…
          </div>
        )}

        {loadState === 'error' && (
          <div className="mt-8 text-center">
            <p className="text-sm text-[var(--color-stellar-rose)]">{error}</p>
            <button onClick={() => router.replace('/dashboard')} className="btn-ghost mt-6 text-sm">
              Back to dashboard
            </button>
          </div>
        )}

        {loadState === 'ready' && (
          <>
            <div className="mt-6 flex flex-col items-center text-center">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-ink-50)] text-[var(--color-ink-700)]">
                <ShieldCheck size={22} />
              </span>
              <h1 className="mt-4 text-lg font-semibold text-[var(--color-ink-900)]">
                Authorize <span className="text-[var(--color-stellar-gold)]">{clientName}</span>
              </h1>
              <p className="mt-1 text-sm text-[var(--color-ink-500)]">
                wants to connect to your Verivyx account.
              </p>
            </div>

            <div className="mt-6 flex flex-col gap-3">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                <Wallet size={16} className="mt-0.5 shrink-0 text-[var(--color-ink-500)]" />
                <span className="text-sm text-[var(--color-ink-700)]">
                  Pay for x402 resources from your linked wallet — limited by the budget and expiry
                  you set. It can never exceed them, and you can revoke any time.
                </span>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                <Clock size={16} className="mt-0.5 shrink-0 text-[var(--color-ink-500)]" />
                <span className="text-sm text-[var(--color-ink-700)]">
                  Stay connected so it can keep paying until you disconnect or the delegation expires.
                </span>
              </div>
            </div>

            {error && <p className="mt-4 text-center text-sm text-[var(--color-stellar-rose)]">{error}</p>}

            <div className="mt-7 flex flex-col gap-3">
              <button
                onClick={() => decide(true)}
                disabled={busy !== null}
                className="btn-yellow disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'allow' ? (
                  <>
                    <Loader2 className="animate-spin" size={16} /> Authorizing…
                  </>
                ) : (
                  'Allow access'
                )}
              </button>
              <button
                onClick={() => decide(false)}
                disabled={busy !== null}
                className="btn-ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'deny' ? 'Cancelling…' : 'Deny'}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function ConsentPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[var(--color-cream-50)]">
          <Loader2 className="animate-spin text-[var(--color-ink-500)]" size={20} />
        </main>
      }
    >
      <ConsentInner />
    </Suspense>
  );
}
