import { Logo } from '@/components/Logo';

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-cream-200)] bg-[var(--color-cream-50)]">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-6 py-16 md:grid-cols-4">
        <div className="md:col-span-2">
          <Logo />
          <p className="mt-4 max-w-sm text-sm text-[var(--color-ink-500)]">
            Agent-native paywall infrastructure. Built on Stellar Soroban with the x402 protocol.
          </p>
          <div className="mt-6 flex items-center gap-2 text-xs text-[var(--color-ink-500)]">
            <span className="live-dot inline-block h-2 w-2 rounded-full bg-[var(--color-stellar-yellow)]" />
            Soroban Testnet · Live
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Product</p>
          <ul className="mt-4 space-y-2 text-sm text-[var(--color-ink-700)]">
            <li><a href="https://verivyx.com/#how-it-works" className="hover:text-[var(--color-ink-900)]">How it works</a></li>
            <li><a href="https://verivyx.com/#features" className="hover:text-[var(--color-ink-900)]">Features</a></li>
            <li><a href="https://verivyx.com/#pricing" className="hover:text-[var(--color-ink-900)]">Pricing</a></li>
            <li><a href="https://verivyx.com/dashboard" className="hover:text-[var(--color-ink-900)]">Dashboard</a></li>
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Build</p>
          <ul className="mt-4 space-y-2 text-sm text-[var(--color-ink-700)]">
            <li><a href="https://docs.verivyx.com" className="hover:text-[var(--color-ink-900)]">Docs</a></li>
            <li><a href="https://docs.verivyx.com/docs/quickstart" className="hover:text-[var(--color-ink-900)]">Quickstart</a></li>
            <li><a href="https://playground.verivyx.com" className="hover:text-[var(--color-ink-900)]">Playground</a></li>
            <li><a href="https://verivyx.com/register" className="hover:text-[var(--color-ink-900)]">Get started</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-[var(--color-cream-200)] py-6 text-center text-xs text-[var(--color-ink-500)]">
        © {new Date().getFullYear()} Verivyx · Built with Stellar Soroban + x402
      </div>
    </footer>
  );
}
