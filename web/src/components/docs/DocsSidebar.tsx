'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';

type Item = { label: string; href: string; external?: boolean; reload?: boolean };

export const DOCS_NAV: { title: string; items: Item[] }[] = [
  {
    title: 'Getting started',
    items: [
      { label: 'Introduction', href: '/docs' },
      { label: 'Quickstart', href: '/docs/quickstart' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { label: 'Embed script', href: '/docs/embed' },
      { label: 'WordPress plugin', href: '/docs/wordpress' },
      { label: 'How agents pay (x402)', href: '/docs/x402' },
    ],
  },
  {
    title: 'For AI agents',
    items: [
      { label: 'x402 MCP server', href: '/docs/mcp' },
    ],
  },
  {
    title: 'API reference',
    items: [
      { label: 'API reference', href: '/docs/api', reload: true },
    ],
  },
  {
    title: 'Resources',
    items: [
      { label: 'Playground', href: 'https://playground.verivyx.com', external: true },
      { label: 'Roadmap', href: '/docs/roadmap' },
    ],
  },
];

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="space-y-7 text-sm">
      {DOCS_NAV.map((group) => (
        <div key={group.title}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-300)]">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = !item.external && pathname === item.href;
              const cls = `flex items-center justify-between rounded-lg px-3 py-1.5 transition ${
                active
                  ? 'bg-[var(--color-stellar-yellow-soft)] font-medium text-[var(--color-ink-900)]'
                  : 'text-[var(--color-ink-700)] hover:bg-[var(--color-cream-100)]'
              }`;
              return (
                <li key={item.href}>
                  {item.external ? (
                    <a href={item.href} target="_blank" rel="noopener noreferrer" className={cls}>
                      {item.label}
                      <ArrowUpRight size={13} className="text-[var(--color-ink-300)]" />
                    </a>
                  ) : item.reload ? (
                    <a href={item.href} className={cls}>
                      {item.label}
                    </a>
                  ) : (
                    <Link href={item.href} className={cls}>
                      {item.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
