'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, MailCheck, TriangleAlert } from 'lucide-react';
import { SiteHeader } from '@/components/SiteHeader';
import { api, saveSession } from '@/lib/api';

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [phase, setPhase] = useState<'verifying' | 'error'>('verifying');
  const [message, setMessage] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [resent, setResent] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React strict-mode double-invoke
    ran.current = true;

    if (!token) {
      setPhase('error');
      setMessage('This verification link is missing its token.');
      return;
    }
    api
      .verifyEmail(token)
      .then((data) => {
        saveSession(data.token, data.user);
        router.replace(data.user.needsOnboarding ? '/onboarding' : '/dashboard');
      })
      .catch((e) => {
        setPhase('error');
        setMessage(e instanceof Error ? e.message : 'Verification failed.');
      });
  }, [token, router]);

  const handleResend = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resendEmail)) return;
    try {
      await api.resendVerification(resendEmail.trim().toLowerCase());
    } finally {
      setResent(true);
    }
  };

  return (
    <main className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden px-6 py-16">
      <div className="absolute inset-0 hero-mesh" aria-hidden />
      <div className="relative w-full max-w-md surface-card p-8 text-center">
        {phase === 'verifying' ? (
          <>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
              <Loader2 size={22} className="animate-spin" />
            </span>
            <h1 className="mt-5 text-xl font-semibold">Verifying your email…</h1>
            <p className="mt-2 text-sm text-[var(--color-ink-500)]">One moment while we confirm your link.</p>
          </>
        ) : (
          <>
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-stellar-rose)] text-white">
              <TriangleAlert size={22} />
            </span>
            <h1 className="mt-5 text-xl font-semibold">Verification failed</h1>
            <p className="mt-2 text-sm text-[var(--color-ink-500)]">{message}</p>

            <div className="mt-6 border-t border-[var(--color-cream-200)] pt-6 text-left">
              <p className="flex items-center gap-2 text-sm font-medium">
                <MailCheck size={15} /> Resend a verification link
              </p>
              {resent ? (
                <p className="mt-2 text-sm text-[var(--color-ink-700)]">
                  If that email is registered and unverified, a new link is on its way.
                </p>
              ) : (
                <div className="mt-3 flex gap-2">
                  <input
                    type="email"
                    className="input-field flex-1"
                    placeholder="your@email.com"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                  />
                  <button onClick={handleResend} className="btn-yellow text-sm">
                    Resend
                  </button>
                </div>
              )}
              <p className="mt-4 text-xs text-[var(--color-ink-300)]">
                Already verified?{' '}
                <Link href="/login" className="underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4">
                  Log in
                </Link>
                .
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen bg-white">
      <SiteHeader variant="auth" />
      <Suspense fallback={<div className="p-16 text-center text-sm text-[var(--color-ink-500)]">Loading…</div>}>
        <VerifyInner />
      </Suspense>
    </div>
  );
}
