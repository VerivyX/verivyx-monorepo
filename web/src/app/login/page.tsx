'use client';

import React, { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, ArrowRight, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { SiteHeader } from '@/components/SiteHeader';
import { Logo } from '@/components/Logo';
import { Turnstile, TURNSTILE_SITE_KEY } from '@/components/Turnstile';
import { api, saveSession } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleToken = useCallback((t: string) => setToken(t), []);
  // Clear the token without remounting — safe to call from error/expired callbacks.
  const clearToken = useCallback(() => setToken(''), []);
  // Remount the widget for a fresh single-use token. Only call after a submit attempt.
  const resetCaptcha = () => {
    setToken('');
    setCaptchaKey((k) => k + 1);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverified(false);
    setLoading(true);
    try {
      const data = await api.login({ email: email.trim().toLowerCase(), password, turnstileToken: token });
      saveSession(data.token, data.user);
      router.push(data.user.needsOnboarding ? '/onboarding' : '/dashboard');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      if (msg === 'email_not_verified') {
        setUnverified(true);
      } else {
        setError(msg);
      }
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await api.resendVerification(email.trim().toLowerCase());
    } finally {
      setResent(true); // response is intentionally generic
    }
  };

  const canSubmit = !loading && (!TURNSTILE_SITE_KEY || token.length > 0);

  return (
    <div className="min-h-screen bg-white">
      <SiteHeader variant="auth" />

      <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden px-6 py-16">
        <div className="absolute inset-0 hero-mesh" aria-hidden />

        <div className="relative grid w-full max-w-5xl grid-cols-1 overflow-hidden rounded-3xl border border-[var(--color-cream-200)] bg-white shadow-[0_24px_64px_-32px_rgba(10,10,10,0.18)] md:grid-cols-2">
          {/* Left brand panel */}
          <div className="hidden flex-col justify-between bg-[var(--color-ink-900)] p-10 text-white md:flex">
            <div>
              <Logo tone="light" />
              <h2 className="mt-12 text-3xl font-semibold tracking-tight md:text-4xl">
                Welcome back.
                <br />
                Your agents are <span className="bg-[var(--color-stellar-yellow)] px-1 text-[var(--color-ink-900)]">paying.</span>
              </h2>
              <p className="mt-4 max-w-sm text-sm text-white/70">
                Pick up where you left off — review settled USDC, agent intercepts, and tune your
                per-request pricing.
              </p>
            </div>
            <div className="mt-12 grid grid-cols-3 gap-4 border-t border-white/10 pt-8 text-xs text-white/60">
              <div>
                <p className="font-mono text-2xl font-semibold text-[var(--color-stellar-yellow)]">3-5s</p>
                <p>Stellar settle</p>
              </div>
              <div>
                <p className="font-mono text-2xl font-semibold text-[var(--color-stellar-yellow)]">2 rails</p>
                <p>Soroban + classic</p>
              </div>
              <div>
                <p className="font-mono text-2xl font-semibold text-[var(--color-stellar-yellow)]">USDC</p>
                <p>Native asset</p>
              </div>
            </div>
          </div>

          {/* Form */}
          <div className="p-10 md:p-14">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Login to your dashboard</h1>
            <p className="mt-2 text-sm text-[var(--color-ink-500)]">
              No account?{' '}
              <Link href="/register" className="font-medium text-[var(--color-ink-900)] underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4">
                Register a creator account
              </Link>
              .
            </p>

            <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
              <label className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  <Mail size={14} /> Email
                </span>
                <input
                  type="email"
                  required
                  className="input-field"
                  placeholder="creator@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  <Lock size={14} /> Password
                </span>
                <input
                  type="password"
                  required
                  className="input-field"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>

              {TURNSTILE_SITE_KEY && (
                <Turnstile key={captchaKey} siteKey={TURNSTILE_SITE_KEY} onToken={handleToken} onError={clearToken} />
              )}

              {unverified && (
                <div className="rounded-xl border border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow-soft)]/50 p-3 text-sm">
                  <p className="flex items-center gap-2 font-medium text-[var(--color-ink-900)]">
                    <MailCheck size={15} /> Verify your email to continue
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-ink-700)]">
                    We sent a verification link to <span className="font-medium">{email}</span>.
                  </p>
                  {resent ? (
                    <p className="mt-2 text-xs text-[var(--color-ink-700)]">Sent again — check your inbox (and spam).</p>
                  ) : (
                    <button type="button" onClick={handleResend} className="mt-2 text-xs font-semibold text-[var(--color-ink-900)] underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4">
                      Resend verification email
                    </button>
                  )}
                </div>
              )}

              {error && (
                <p className="rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
                  {error}
                </p>
              )}

              <button type="submit" disabled={!canSubmit} className="btn-yellow mt-2 disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? 'Logging in…' : 'Login to dashboard'}
                <ArrowRight size={18} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
