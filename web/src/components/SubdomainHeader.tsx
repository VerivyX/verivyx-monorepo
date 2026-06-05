import { ArrowUpRight } from 'lucide-react';
import { Logo } from '@/components/Logo';

// Header for pages served on their own subdomain (e.g. mcp.verivyx.com). Unlike
// the marketing SiteHeader, every link is absolute to its canonical host so the
// header behaves correctly regardless of which subdomain is serving the app.
export function SubdomainHeader({ label }: { label: string }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <a href="https://verivyx.com" className="flex items-center">
            <Logo />
          </a>
          <span className="hidden rounded-full bg-[var(--color-cream-100)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink-500)] sm:inline">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://docs.verivyx.com" className="btn-ghost hidden text-sm sm:inline-flex">
            Docs <ArrowUpRight size={14} />
          </a>
          <a href="https://playground.verivyx.com" className="btn-ghost hidden text-sm sm:inline-flex">
            Playground <ArrowUpRight size={14} />
          </a>
          <a href="https://verivyx.com/dashboard" className="btn-yellow text-sm">
            Open app
          </a>
        </div>
      </div>
    </header>
  );
}
