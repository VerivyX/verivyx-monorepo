'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Keypair } from '@stellar/stellar-sdk';
import {
  Wallet,
  Sparkles,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { SiteHeader } from '@/components/SiteHeader';
import {
  api,
  getStoredUser,
  updateStoredUser,
  STELLAR_PUBKEY_REGEX,
} from '@/lib/api';

export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Guard: require a session, bounce out if onboarding is already done.
  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) {
      router.replace('/login');
      return;
    }
    api
      .me()
      .then(({ user }) => {
        if (!user.needsOnboarding) {
          router.replace('/dashboard');
          return;
        }
        if (user.stellar_address) setPublicKey(user.stellar_address);
        setReady(true);
      })
      .catch(() => {
        // Stale/invalid token → back to login.
        router.replace('/login');
      });
  }, [router]);

  const stellarValid = STELLAR_PUBKEY_REGEX.test(publicKey.trim());

  const handleGenerateWallet = () => {
    const pair = Keypair.random();
    setPublicKey(pair.publicKey());
    setSecretKey(pair.secret());
  };

  const handleFinish = async () => {
    if (!stellarValid) return;
    setSaving(true);
    setError(null);
    try {
      const { user } = await api.updateSettings({
        stellar_address: publicKey.trim(),
      });
      updateStoredUser(user);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your setup.');
    } finally {
      setSaving(false);
    }
  };

  if (!ready) {
    return (
      <div className="min-h-screen bg-white">
        <SiteHeader variant="auth" />
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center text-sm text-[var(--color-ink-500)]">
          <Loader2 size={16} className="mr-2 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <SiteHeader variant="auth" />
      <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden px-6 py-16">
        <div className="absolute inset-0 hero-mesh" aria-hidden />
        <div className="relative w-full max-w-[560px] surface-card p-8 md:p-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Almost there
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Where should payments land?</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-500)]">
            Your Stellar wallet address. Paste an existing one, or generate a fresh testnet wallet.
            USDC from agents settles straight here.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                <Wallet size={14} /> Stellar public key
              </span>
              <button
                type="button"
                onClick={handleGenerateWallet}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-ink-900)] underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4 hover:opacity-80"
              >
                <Sparkles size={12} /> Generate testnet wallet
              </button>
            </div>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="input-field font-mono text-sm"
              placeholder="G… (56 chars)"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
            />
            {publicKey.trim().length > 0 && !stellarValid && (
              <p className="text-xs text-[var(--color-stellar-rose)]">
                Stellar public key must start with G and be 56 characters.
              </p>
            )}
            {secretKey && (
              <div className="mt-2 flex items-start gap-2 rounded-xl border border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow-soft)] p-3 text-xs text-[var(--color-ink-900)]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">Save this secret key — shown once:</p>
                  <code className="mt-1 block break-all font-mono text-[11px] text-[var(--color-ink-900)]">
                    {secretKey}
                  </code>
                </div>
              </div>
            )}
          </div>

          <p className="mt-4 flex items-start gap-2 text-xs text-[var(--color-ink-500)]">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--color-ink-900)]" />
            After this, grab your SDK token from Integrations and add one line of middleware — no
            domain or DNS setup required.
          </p>

          {error && (
            <p className="mt-4 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
              {error}
            </p>
          )}

          <button
            onClick={handleFinish}
            disabled={!stellarValid || saving}
            className="btn-yellow mt-8 w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Saving…
              </>
            ) : (
              <>
                Finish setup <ArrowRight size={18} />
              </>
            )}
          </button>
        </div>
      </main>
    </div>
  );
}
