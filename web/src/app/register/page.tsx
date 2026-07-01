'use client';

import React, { useCallback, useState } from 'react';
import { Mail, Lock, ArrowRight, CheckCircle2, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { SiteHeader } from '@/components/SiteHeader';
import { Logo } from '@/components/Logo';
import { Turnstile, TURNSTILE_SITE_KEY } from '@/components/Turnstile';
import { api } from '@/lib/api';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordValid = password.length >= 6;
  const captchaOk = !TURNSTILE_SITE_KEY || token.length > 0;
  const formValid = emailValid && passwordValid && captchaOk && !loading;

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
    if (!emailValid || !passwordValid) {
      setError('Please fix the highlighted fields.');
      return;
    }
    setLoading(true);
    try {
      await api.register({ email: email.trim().toLowerCase(), password, turnstileToken: token });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await api.resendVerification(email.trim().toLowerCase());
    } finally {
      setResent(true);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <SiteHeader variant="auth" />

      <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden px-6 py-16">
        <div className="absolute inset-0 hero-mesh" aria-hidden />

        <div className="relative grid w-full max-w-5xl grid-cols-1 overflow-hidden rounded-3xl border border-[var(--color-cream-200)] bg-white shadow-[0_24px_64px_-32px_rgba(10,10,10,0.22)] md:grid-cols-2">
          {/* Left panel */}
          <div className="hidden flex-col justify-between bg-[var(--color-cream-100)] p-11 md:flex">
            <div>
              <Logo />
              <h2 className="mt-12 text-3xl font-semibold tracking-tight md:text-4xl">
                Become a{' '}
                <span className="bg-[var(--color-stellar-yellow)] px-1">creator</span> in 60s.
              </h2>
              <p className="mt-4 max-w-sm text-sm text-[var(--color-ink-500)]">
                Start with just an email. After you verify it, we&apos;ll walk you through connecting
                your domain and Stellar wallet — then drop one script tag and start charging agents.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-[var(--color-ink-700)]">
                {[
                  'Verify your email',
                  'Connect domain + Stellar wallet (guided)',
                  'Drop the script tag and go live',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--color-ink-900)]" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Form / sent state */}
          <div className="p-10 md:p-12">
            {sent ? (
              <div className="flex flex-col items-start">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
                  <MailCheck size={24} />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">Check your email</h1>
                <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                  We sent a verification link to <span className="font-medium text-[var(--color-ink-900)]">{email}</span>.
                  Click it to activate your account, then log in.
                </p>
                <p className="mt-4 text-xs text-[var(--color-ink-300)]">
                  Can&apos;t find it? Check your spam folder, or resend below. The link expires in 24 hours.
                </p>
                <div className="mt-6 flex items-center gap-3">
                  {resent ? (
                    <span className="text-sm text-[var(--color-ink-700)]">Sent again ✓</span>
                  ) : (
                    <button onClick={handleResend} className="btn-ghost text-sm">
                      Resend email
                    </button>
                  )}
                  <Link href="/login" className="btn-yellow text-sm">
                    Go to login <ArrowRight size={16} />
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Create your account</h1>
                <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                  Already have one?{' '}
                  <Link href="/login" className="font-medium text-[var(--color-ink-900)] underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4">
                    Login
                  </Link>
                  .
                </p>

                <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
                  <label className="flex flex-col gap-2">
                    <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-500)]">
                      <Mail size={14} /> Email
                    </span>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      className="input-field"
                      placeholder="creator@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    {email.length > 0 && !emailValid && (
                      <span className="text-xs text-[var(--color-stellar-rose)]">Enter a valid email</span>
                    )}
                  </label>

                  <label className="flex flex-col gap-2">
                    <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-500)]">
                      <Lock size={14} /> Password
                    </span>
                    <input
                      type="password"
                      required
                      minLength={6}
                      autoComplete="new-password"
                      className="input-field"
                      placeholder="At least 6 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    {password.length > 0 && !passwordValid && (
                      <span className="text-xs text-[var(--color-stellar-rose)]">Minimum 6 characters</span>
                    )}
                  </label>

                  {TURNSTILE_SITE_KEY && (
                    <Turnstile key={captchaKey} siteKey={TURNSTILE_SITE_KEY} onToken={handleToken} onError={clearToken} />
                  )}

                  {error && (
                    <p className="rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
                      {error}
                    </p>
                  )}

                  <button type="submit" disabled={!formValid} className="btn-yellow mt-2 disabled:cursor-not-allowed disabled:opacity-50">
                    {loading ? 'Creating…' : 'Create account'}
                    <ArrowRight size={18} />
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
