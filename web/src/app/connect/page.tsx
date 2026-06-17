'use client';

import React, { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_API_URL ?? '';

type Phase = 'ready' | 'working' | 'error';

function ConnectInner() {
  const params = useSearchParams();
  const connectId = params.get('connect_id') ?? '';
  const state = params.get('state') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const site = params.get('site') ?? '';

  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState('');

  const token = useMemo(
    () => (typeof window !== 'undefined' ? window.localStorage.getItem('paywall_token') : null),
    [],
  );

  // Open-redirect guard: the return URL must be http(s) on the same host we are authorizing.
  const safeRedirect = useMemo(() => {
    try {
      const u = new URL(redirectUri);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (site && u.hostname !== site) return null;
      return u;
    } catch {
      return null;
    }
  }, [redirectUri, site]);

  const paramsValid = connectId !== '' && state !== '' && safeRedirect !== null;

  async function authorize() {
    setPhase('working');
    setError('');
    try {
      const res = await fetch(`${API}/api/v1/domains/connect/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ connect_id: connectId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const map: Record<string, string> = {
          confirm_failed: 'Could not reach or verify your site. Make sure the plugin is active and the site is publicly reachable, then retry.',
          invalid_site: 'That site address is not allowed.',
          domain_conflict: 'This domain is already linked to a different Verivyx account.',
          expired: 'This connection request expired. Please start again from WordPress.',
          unknown_connect: 'This connection request was not found. Please start again from WordPress.',
        };
        setError(map[body.error ?? ''] ?? 'Authorization failed. Please try again.');
        setPhase('error');
        return;
      }
      const { code } = (await res.json()) as { code: string };
      const u = safeRedirect!;
      u.searchParams.set('code', code);
      u.searchParams.set('state', state);
      window.location.href = u.toString();
    } catch {
      setError('Network error. Please try again.');
      setPhase('error');
    }
  }

  if (!paramsValid) {
    return <Card><p>This connection link is invalid or incomplete. Please start the connection again from your WordPress admin.</p></Card>;
  }

  if (!token) {
    const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/connect';
    return (
      <Card>
        <p className="mb-4">Please log in to your Verivyx account to authorize this site.</p>
        <a className="inline-block rounded bg-black px-4 py-2 text-white" href={`/login?next=${encodeURIComponent(next)}`}>
          Log in to continue
        </a>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-2 text-xl font-semibold">Connect to Verivyx</h1>
      <p className="mb-6 text-sm text-gray-600">
        Authorize <strong>{site}</strong> to use Verivyx full withholding. We will verify your site
        automatically — nothing else to set up.
      </p>
      {phase === 'error' && <p className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button
        onClick={authorize}
        disabled={phase === 'working'}
        className="rounded bg-black px-5 py-2 text-white disabled:opacity-60"
      >
        {phase === 'working' ? 'Authorizing…' : `Authorize ${site}`}
      </button>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-xl border bg-white p-8 shadow-sm">{children}</div>
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<Card><p>Loading…</p></Card>}>
      <ConnectInner />
    </Suspense>
  );
}
