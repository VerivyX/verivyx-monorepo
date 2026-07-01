import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

// Typography primitives for docs pages — Tailwind-only, server-renderable.

// Bordered link card used in "Next steps" grids.
export function NextCard({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith('http');
  const cls =
    'flex items-center justify-between rounded-xl border border-[var(--color-cream-200)] px-4 py-3.5 text-sm font-medium text-[var(--color-ink-900)] transition hover:border-[#d6d4c8] hover:bg-[var(--color-cream-50)]';
  const inner = (
    <>
      {children}
      <ArrowRight size={15} className="text-[var(--color-ink-300)]" />
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}

export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-lg leading-relaxed text-[var(--color-ink-500)]">{children}</p>;
}

export function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-12 scroll-mt-24 text-2xl font-semibold tracking-tight text-[var(--color-ink-900)]">
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mt-8 scroll-mt-24 text-lg font-semibold text-[var(--color-ink-900)]">
      {children}
    </h3>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 leading-relaxed text-[var(--color-ink-700)]">{children}</p>;
}

export function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="mt-4 space-y-2 text-[var(--color-ink-700)]">{children}</ul>;
}

export function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 leading-relaxed">
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-stellar-yellow)]" />
      <span>{children}</span>
    </li>
  );
}

export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="font-medium text-[var(--color-ink-900)] underline decoration-[var(--color-stellar-yellow)] decoration-2 underline-offset-4 hover:opacity-80"
    >
      {children}
    </a>
  );
}

// Inline code.
export function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-[var(--color-cream-100)] px-1.5 py-0.5 font-mono text-[0.85em] text-[var(--color-ink-900)]">
      {children}
    </code>
  );
}

// Clean reference table. `head` is the column labels; `rows` is a list of cells.
export function Table({ head, rows }: { head: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-cream-200)]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-[var(--color-cream-100)] text-left">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-semibold text-[var(--color-ink-900)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-[var(--color-cream-200)] align-top">
              {row.map((cell, ci) => (
                <td key={ci} className="px-4 py-2.5 leading-relaxed text-[var(--color-ink-700)]">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow-soft)]/40 px-4 py-3 text-sm text-[var(--color-ink-700)]">
      {children}
    </div>
  );
}
