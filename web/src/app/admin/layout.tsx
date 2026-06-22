'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, LogOut, Boxes, ReceiptText, ScrollText, Shield, Users } from 'lucide-react';
import { api, clearSession, getStoredUser, saveSession } from '@/lib/api';

const NAV = [
  { href: '/admin', label: 'Financial Hub', icon: BarChart3 },
  { href: '/admin/transactions', label: 'Transactions', icon: ReceiptText },
  { href: '/admin/creators', label: 'Creators', icon: Users },
  { href: '/admin/mcp', label: 'MCP', icon: Boxes },
  { href: '/admin/logs', label: 'Audit Logs', icon: ScrollText },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState('');

  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) { router.replace('/login'); return; }

    // Always verify role from server — localStorage can be stale
    // (e.g. user was promoted to ADMIN after last login)
    api.me().then(({ user }) => {
      if (user.role !== 'ADMIN') { router.replace('/dashboard'); return; }
      // Refresh localStorage so future checks are accurate
      const token = localStorage.getItem('paywall_token') ?? '';
      saveSession(token, user);
      setEmail(user.email);
    }).catch(() => {
      router.replace('/login');
    });
  }, [router]);

  async function logout() {
    // Best-effort: end the Hydra SSO session so a new MCP connector can't
    // silently re-authorize. Always clear the local session + redirect.
    await api.oauthLogout().catch(() => {});
    clearSession();
    router.push('/login');
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-cream-50)]">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 flex flex-col bg-white border-r border-[var(--color-cream-200)] shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
        {/* Brand */}
        <div className="px-6 py-8 border-b border-[var(--color-cream-100)]">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <Shield size={16} className="text-white" />
            </div>
            <span className="text-[var(--color-ink-900)] font-bold text-lg tracking-tight">
              Verivyx Admin
            </span>
          </div>
          <p className="mt-2 text-xs text-[var(--color-ink-500)] font-medium truncate">{email}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-6 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  active
                    ? 'bg-indigo-50 text-indigo-700 font-semibold'
                    : 'text-[var(--color-ink-500)] hover:bg-[var(--color-cream-100)] hover:text-[var(--color-ink-900)]'
                }`}
              >
                <Icon
                  size={18}
                  strokeWidth={active ? 2.5 : 2}
                  className={active ? 'text-indigo-600' : ''}
                />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Footer actions */}
        <div className="px-3 py-5 border-t border-[var(--color-cream-100)] flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm text-[var(--color-ink-500)] hover:bg-[var(--color-cream-100)] hover:text-[var(--color-ink-900)] transition-colors font-medium"
          >
            ← Creator Dashboard
          </Link>
          <button
            onClick={logout}
            className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors font-semibold w-full text-left"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto px-16 py-12">
        {children}
      </main>
    </div>
  );
}
