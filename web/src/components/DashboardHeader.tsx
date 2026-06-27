'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { LogoMark } from '@/components/Logo';

type Width = 'wide' | 'mid' | 'read';

const widthClass: Record<Width, string> = {
  wide: 'app-width-wide',
  mid: 'app-width-mid',
  read: 'app-width-read',
};

/**
 * One header for every dashboard page. Two shapes:
 *   - `crumb` set → a breadcrumb back to the dashboard plus the page name
 *     (used by sub-pages like Get Script, Transactions, Test, Agent Wallet).
 *   - `crumb` omitted → the brand lockup (used by the dashboard home).
 *
 * `width` keeps the header's content aligned with the page's main column.
 * `actions` renders page-specific controls (Refresh, Logout, nav) on the right.
 */
export function DashboardHeader({
  crumb,
  subtitle,
  width = 'wide',
  actions,
}: {
  crumb?: string;
  subtitle?: string;
  width?: Width;
  actions?: React.ReactNode;
}) {
  return (
    <header className="app-header">
      <div className={`app-header__inner ${widthClass[width]}`}>
        <div className="flex min-w-0 items-center gap-3">
          {crumb ? (
            <>
              <Link href="/dashboard" className="btn-ghost text-sm">
                <ArrowLeft size={14} /> Dashboard
              </Link>
              <span aria-hidden className="text-sm text-[var(--color-ink-300)]">
                /
              </span>
              <p className="truncate text-sm font-semibold tracking-tight">{crumb}</p>
            </>
          ) : (
            <>
              <LogoMark size={32} />
              <div className="leading-tight">
                <p className="text-sm font-semibold tracking-tight">Verivyx</p>
                <p className="text-xs text-[var(--color-ink-500)]">{subtitle ?? 'Creator dashboard'}</p>
              </div>
            </>
          )}
        </div>

        {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </header>
  );
}
