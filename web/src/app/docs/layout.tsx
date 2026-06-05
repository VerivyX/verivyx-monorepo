import React from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { DocsSidebar } from '@/components/docs/DocsSidebar';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <a href="https://verivyx.com" className="flex items-center">
              <Logo />
            </a>
            <span className="hidden rounded-full bg-[var(--color-cream-100)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink-500)] sm:inline">
              Docs
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="https://playground.verivyx.com"
              className="btn-ghost hidden text-sm sm:inline-flex"
            >
              Playground <ArrowUpRight size={14} />
            </a>
            <Link href="/dashboard" className="btn-yellow text-sm">
              Open app
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-6 py-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Sidebar */}
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <DocsSidebar />
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 max-w-3xl">{children}</main>
      </div>
    </div>
  );
}
