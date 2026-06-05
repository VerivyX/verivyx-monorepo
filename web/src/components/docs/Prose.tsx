import React from 'react';

// Typography primitives for docs pages — Tailwind-only, server-renderable.

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

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow-soft)]/40 px-4 py-3 text-sm text-[var(--color-ink-700)]">
      {children}
    </div>
  );
}
