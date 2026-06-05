'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { getStoredUser } from '@/lib/api';
import { Logo } from '@/components/Logo';

export function SiteHeader({ variant = 'marketing' }: { variant?: 'marketing' | 'auth' }) {
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    setHasSession(Boolean(getStoredUser()));
  }, []);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center">
          <Logo />
        </Link>

        {variant === 'marketing' && (
          <nav className="hidden items-center gap-8 text-sm text-[var(--color-ink-700)] md:flex">
            <a href="#how-it-works" className="hover:text-[var(--color-ink-900)]">How it works</a>
            <a href="#features" className="hover:text-[var(--color-ink-900)]">Features</a>
            <a
              href="https://mcp.verivyx.com"
              className="inline-flex items-center gap-1 hover:text-[var(--color-ink-900)]"
            >
              MCP <ArrowUpRight size={13} />
            </a>
            <a
              href="https://playground.verivyx.com"
              className="inline-flex items-center gap-1 hover:text-[var(--color-ink-900)]"
            >
              Playground <ArrowUpRight size={13} />
            </a>
            <a
              href="https://docs.verivyx.com"
              className="inline-flex items-center gap-1 hover:text-[var(--color-ink-900)]"
            >
              Docs <ArrowUpRight size={13} />
            </a>
            <a href="#pricing" className="hover:text-[var(--color-ink-900)]">Pricing</a>
          </nav>
        )}

        <div className="flex items-center gap-2">
          {hasSession ? (
            <Link href="/dashboard" className="btn-primary text-sm">
              Open dashboard
              <ArrowUpRight size={16} />
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost text-sm">Login</Link>
              <Link href="/register" className="btn-yellow text-sm">
                Start earning
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
