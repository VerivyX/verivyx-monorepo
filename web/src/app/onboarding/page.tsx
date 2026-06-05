'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Keypair } from '@stellar/stellar-sdk';
import {
  Globe,
  Wallet,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { SiteHeader } from '@/components/SiteHeader';
import {
  api,
  getStoredUser,
  updateStoredUser,
  normalizeDomain,
  STELLAR_PUBKEY_REGEX,
} from '@/lib/api';

export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [domainInput, setDomainInput] = useState('');
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
        if (user.domain) setDomainInput(user.domain);
        if (user.stellar_address) setPublicKey(user.stellar_address);
        setReady(true);
      })
      .catch(() => {
        // Stale/invalid token → back to login.
        router.replace('/login');
      });
  }, [router]);

  const cleanedDomain = normalizeDomain(domainInput);
  const domainValid = Boolean(cleanedDomain);
  const stellarValid = STELLAR_PUBKEY_REGEX.test(publicKey.trim());

  const handleGenerateWallet = () => {
    const pair = Keypair.random();
    setPublicKey(pair.publicKey());
    setSecretKey(pair.secret());
  };

  const handleFinish = async () => {
    if (!cleanedDomain || !stellarValid) return;
    setSaving(true);
    setError(null);
    try {
      const { user } = await api.updateSettings({
        domain: cleanedDomain,
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
        <div className="relative w-full max-w-xl surface-card p-8 md:p-10">
          {/* Progress */}
          <div className="flex items-center gap-3">
            <Stepper n={1} label="Domain" active={step === 1} done={step > 1} />
            <span className="h-px flex-1 bg-[var(--color-cream-200)]" />
            <Stepper n={2} label="Wallet" active={step === 2} done={false} />
          </div>

          {step === 1 ? (
            <div className="mt-8">
              <h1 className="text-2xl font-semibold tracking-tight">Which domain are you monetizing?</h1>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                The site whose content AI agents will pay to access. Just the host — no{' '}
                <span className="font-mono">https://</span>, no path.
              </p>

              <label className="mt-6 flex flex-col gap-2">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  <Globe size={14} /> Domain
                </span>
                <input
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-field"
                  placeholder="my-blog.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                />
                {domainInput.trim().length > 0 && !domainValid && (
                  <span className="text-xs text-[var(--color-stellar-rose)]">
                    Domain must look like example.com (lowercase, with a TLD).
                  </span>
                )}
                {domainValid && cleanedDomain !== domainInput && (
                  <span className="text-xs text-[var(--color-ink-700)]">Will be saved as {cleanedDomain}</span>
                )}
              </label>

              <button
                onClick={() => setStep(2)}
                disabled={!domainValid}
                className="btn-yellow mt-8 w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
              >
                Continue <ArrowRight size={18} />
              </button>
            </div>
          ) : (
            <div className="mt-8">
              <h1 className="text-2xl font-semibold tracking-tight">Where should payments land?</h1>
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
                  <div className="mt-2 flex items-start gap-2 rounded-xl border border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow-soft)]/50 p-3 text-xs text-[var(--color-ink-700)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="font-semibold">Save this secret key — shown once:</p>
                      <code className="mt-1 block break-all font-mono text-[11px] text-[var(--color-ink-900)]">
                        {secretKey}
                      </code>
                    </div>
                  </div>
                )}
              </div>

              <p className="mt-4 flex items-start gap-2 text-xs text-[var(--color-ink-500)]">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--color-ink-900)]" />
                You&apos;ll activate this wallet to receive USDC (a one-time trustline) from your dashboard
                right after this.
              </p>

              {error && (
                <p className="mt-4 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
                  {error}
                </p>
              )}

              <div className="mt-8 flex items-center gap-3">
                <button onClick={() => setStep(1)} className="btn-ghost text-sm">
                  <ArrowLeft size={16} /> Back
                </button>
                <button
                  onClick={handleFinish}
                  disabled={!stellarValid || !domainValid || saving}
                  className="btn-yellow flex-1 justify-center disabled:cursor-not-allowed disabled:opacity-50"
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
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Stepper({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${
          done
            ? 'bg-[var(--color-stellar-mint)] text-[var(--color-ink-900)]'
            : active
              ? 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]'
              : 'bg-[var(--color-cream-200)] text-[var(--color-ink-500)]'
        }`}
      >
        {done ? <CheckCircle2 size={14} /> : n}
      </span>
      <span className={`text-sm ${active || done ? 'text-[var(--color-ink-900)]' : 'text-[var(--color-ink-300)]'}`}>
        {label}
      </span>
    </div>
  );
}
