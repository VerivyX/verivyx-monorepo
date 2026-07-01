import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Coins,
  EyeOff,
  Globe,
  Cpu,
  ChevronRight,
  Lock,
  Check,
} from 'lucide-react';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';

const trustedBots = [
  'GPTBot',
  'PerplexityBot',
  'ClaudeBot',
  'Google-Extended',
  'ByteSpider',
  'CCBot',
  'Cohere-AI',
  'Bingbot',
];

export default function LandingPage() {
  return (
    <>
      <SiteHeader />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 hero-mesh" aria-hidden />
        <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-6 pb-20 pt-24 md:grid-cols-12 md:pt-32">
          <div className="md:col-span-7">
            <div className="tag-chip">
              <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-yellow)]" />
              x402 protocol · Stellar Soroban
            </div>
            <h1 className="mt-6 text-5xl font-semibold tracking-tight md:text-7xl md:leading-[1.02]">
              Charge AI agents{' '}
              <span className="bg-[var(--color-stellar-yellow)] px-2 italic">per request.</span>
              <br />
              Let humans browse free.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-[var(--color-ink-500)]">
              Verivyx sits in front of your content. It tells humans from agents, hides text from
              scrapers, and forces every AI request to settle a USDC micropayment over Stellar
              before it sees a single token.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/register" className="btn-yellow">
                Start earning <ArrowRight size={18} />
              </Link>
              <a href="#how-it-works" className="btn-ghost">
                See the flow <ChevronRight size={16} />
              </a>
            </div>

            <div className="mt-12 grid max-w-lg grid-cols-3 gap-6 border-t border-[var(--color-cream-200)] pt-8">
              <div>
                <p className="font-mono text-2xl font-semibold">2 rails</p>
                <p className="text-xs text-[var(--color-ink-500)]">Soroban + classic USDC</p>
              </div>
              <div>
                <p className="font-mono text-2xl font-semibold">x402 v2</p>
                <p className="text-xs text-[var(--color-ink-500)]">Pay from any MCP agent</p>
              </div>
              <div>
                <p className="font-mono text-2xl font-semibold">~5s</p>
                <p className="text-xs text-[var(--color-ink-500)]">Stellar settlement</p>
              </div>
            </div>
          </div>

          <div className="md:col-span-5">
            <div className="surface-card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-[var(--color-cream-200)] px-5 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-rose)]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-yellow)]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-mint)]" />
                <span className="ml-3 font-mono text-xs text-[var(--color-ink-500)]">
                  GET your-blog.com/article
                </span>
              </div>
              <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed">
                <p className="text-[var(--color-ink-500)]">
                  &gt; <span className="text-[var(--color-stellar-violet)]">curl</span> -A
                  &quot;GPTBot/1.0&quot; your-blog.com
                </p>
                <p className="rounded-md bg-[var(--color-cream-100)] p-2 text-[var(--color-ink-700)]">
                  HTTP/1.1{' '}
                  <span className="font-semibold text-[var(--color-stellar-rose)]">
                    402 Payment Required
                  </span>
                </p>
                <p className="break-all text-[var(--color-ink-500)]">
                  PAYMENT-REQUIRED:{' '}
                  <span className="text-[var(--color-ink-700)]">eyJ4NDAyVmVyc2lvbiI6Mi4u</span>
                </p>
                <p className="text-[var(--color-ink-500)]">
                  ↳ scheme <span className="text-[var(--color-ink-700)]">exact</span> · net{' '}
                  <span className="text-[var(--color-ink-700)]">stellar:testnet</span> · USDC
                </p>
                <p className="pt-2 text-[var(--color-ink-500)]">
                  &gt; <span className="text-[var(--color-stellar-violet)]">x402</span> sign +
                  retry w/{' '}
                  <span className="text-[var(--color-ink-700)]">PAYMENT-SIGNATURE</span>
                </p>
                <p className="rounded-md bg-[var(--color-stellar-yellow-soft)] p-2 text-[var(--color-ink-900)]">
                  HTTP/1.1{' '}
                  <span className="font-semibold text-[var(--color-stellar-mint)]">200 OK</span> ·
                  content unlocked
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Marquee of bot names */}
        <div className="border-y border-[var(--color-cream-200)] bg-white py-6">
          <p className="px-6 text-center text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Detects, fingerprints, and bills
          </p>
          <div className="mt-4 overflow-hidden">
            <div className="marquee-track flex w-max gap-12 whitespace-nowrap px-6 text-lg font-medium text-[var(--color-ink-700)]">
              {[...trustedBots, ...trustedBots].map((b, i) => (
                <span key={i} className="opacity-70">
                  {b}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* PLAYGROUND */}
      <section className="border-b border-[var(--color-cream-200)] bg-[var(--color-ink-900)] text-white">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-6 py-20 md:grid-cols-12">
          <div className="md:col-span-6">
            <div className="tag-chip border-white/10 bg-white/10 text-white">
              <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-yellow)]" />
              Live demo · Stellar testnet
            </div>
            <h2 className="mt-6 text-4xl font-semibold tracking-tight md:text-5xl">
              Watch an AI agent{' '}
              <span className="bg-[var(--color-stellar-yellow)] px-2 text-[var(--color-ink-900)]">pay for content</span>{' '}
              in real time.
            </h2>
            <p className="mt-5 max-w-lg text-white/70">
              The Verivyx Playground hands a sandboxed agent a funded testnet wallet. Ask it to open a
              paywalled page — it hits a 402, settles USDC over x402 on Stellar, and unlocks the
              content, every step on-chain and visible.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="https://playground.verivyx.com" className="btn-yellow">
                Open the Playground <ArrowUpRight size={18} />
              </a>
              <a href="#how-it-works" className="inline-flex items-center gap-1 text-sm text-white/70 hover:text-white">
                How it works <ChevronRight size={15} />
              </a>
            </div>
          </div>

          {/* Mock payment trace */}
          <div className="md:col-span-6">
            <div className="surface-card overflow-hidden bg-white text-[var(--color-ink-900)]">
              <div className="flex items-center justify-between border-b border-[var(--color-cream-200)] px-4 py-2.5">
                <span className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                  x402 payment trace
                </span>
                <span className="tag-chip">stellar:testnet</span>
              </div>
              <div className="space-y-4 p-5 text-sm">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--color-stellar-mint)]">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <div>
                    <p>Agent requests the demo article</p>
                    <p className="font-mono text-xs text-[var(--color-ink-500)]">GET /demo/article</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--color-stellar-rose)] text-white">
                    <Lock size={11} />
                  </span>
                  <p>HTTP 402 Payment Required</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--color-stellar-mint)]">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <p>Signed USDC payment over x402</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--color-stellar-mint)]">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <div>
                    <p>Settled on Stellar testnet</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-[var(--color-stellar-yellow-soft)] px-2 py-0.5 font-mono text-xs">
                        0.005 USDC
                      </span>
                      <span className="font-mono text-xs text-[var(--color-stellar-violet)]">3f9a…c21d</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-md bg-[var(--color-stellar-yellow-soft)] p-2 text-[13px]">
                  <span className="font-semibold text-[var(--color-stellar-mint)]">200 OK</span> · content
                  unlocked, split on-chain to creator + platform
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-24">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            How it works
          </p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            One script. Three layers between bots and your bytes.
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {[
            {
              icon: <EyeOff className="h-5 w-5" />,
              step: '01',
              title: 'Detect',
              body: 'Embedded heuristics inspect WebGL, mouse motion, navigator fingerprints, and known agent UAs. Humans never notice.',
            },
            {
              icon: <ShieldCheck className="h-5 w-5" />,
              step: '02',
              title: 'Hydrate',
              body: 'Real text never lands in HTML for unverified sessions. Hydration service serves a 402 to bots and decrypted content to humans.',
            },
            {
              icon: <Coins className="h-5 w-5" />,
              step: '03',
              title: 'Settle',
              body: 'Agents that want access pay USDC on Stellar. The x402 facilitator verifies the txn against Horizon, then unlocks for 1h.',
            },
          ].map((s) => (
            <div key={s.step} className="surface-card surface-card-hover p-6">
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]">
                  {s.icon}
                </span>
                <span className="font-mono text-xs text-[var(--color-ink-300)]">{s.step}</span>
              </div>
              <h3 className="mt-6 text-xl font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* WORDPRESS PLUGIN */}
      <section className="mx-auto max-w-7xl px-6 pb-12">
        <div className="surface-card flex flex-col items-start gap-5 p-7 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#21759b] font-bold text-white">
              WP
            </span>
            <div>
              <h3 className="text-lg font-semibold">Running WordPress? Skip the code.</h3>
              <p className="mt-1 max-w-xl text-sm text-[var(--color-ink-500)]">
                Install the Verivyx Paywall plugin and hit activate — zero config. It auto-detects your
                domain and starts charging agents. Humans read free, just like the script tag.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Link href="/register" className="btn-yellow text-sm">
              Get the plugin <ArrowRight size={16} />
            </Link>
            <a href="https://docs.verivyx.com/docs/wordpress" className="btn-ghost text-sm">
              Plugin docs
            </a>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="border-y border-[var(--color-cream-200)] bg-[var(--color-cream-50)] py-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="grid items-end gap-8 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                Built for the agentic web
              </p>
              <h2 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
                The infrastructure layer for
                <span className="bg-[var(--color-stellar-violet-soft)] px-2"> AI revenue.</span>
              </h2>
            </div>
            <p className="text-base text-[var(--color-ink-500)] md:text-lg">
              We&apos;re not robots.txt. We don&apos;t block agents — we charge them. Real-time
              settlement, on-chain auditability, and zero impact on organic readers.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: <Zap className="h-5 w-5" />,
                title: 'Sub-second 402s',
                body: 'Edge detection in <50ms via the embed script. No round-trip to your origin until the agent pays.',
              },
              {
                icon: <Coins className="h-5 w-5" />,
                title: 'Stellar Soroban native',
                body: 'USDC micropayments settle in ~5 seconds with sub-cent fees. The paywall_core contract splits creator + platform on-chain.',
              },
              {
                icon: <Globe className="h-5 w-5" />,
                title: 'Per-domain pricing',
                body: 'Set a different price per request for each property you operate. Update it from the dashboard live.',
              },
              {
                icon: <Cpu className="h-5 w-5" />,
                title: 'Know Your Agent',
                body: 'See which AI labs are reading your archive, in real time. Deep research vs. RAG vs. training.',
              },
              {
                icon: <ShieldCheck className="h-5 w-5" />,
                title: 'No mocks. Real verification.',
                body: 'Every payment is verified on Stellar before unlocking. No trust-the-client shortcuts.',
              },
              {
                icon: <EyeOff className="h-5 w-5" />,
                title: 'Human-friendly',
                body: 'Real users see no challenges, no captchas, no flickers. Just your content.',
              },
            ].map((f, i) => (
              <div key={i} className="surface-card surface-card-hover p-6">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]">
                  {f.icon}
                </span>
                <h3 className="mt-5 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-[var(--color-ink-500)]">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="mx-auto max-w-7xl px-6 py-24">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Pricing
          </p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            Free to deploy. A{' '}
            <span className="bg-[var(--color-stellar-yellow)] px-2">flat fee</span> per settled
            request.
          </h2>
          <p className="mt-4 text-base text-[var(--color-ink-500)]">
            You set the price an agent pays. A small fixed platform fee comes out of each settled
            payment — you keep the rest. No subscriptions, no minimums.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
          <div className="surface-card p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-500)]">
              You set the price
            </p>
            <p className="mt-3 text-4xl font-semibold">You</p>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">per-request, in USDC</p>
            <ul className="mt-6 space-y-2 text-sm text-[var(--color-ink-700)]">
              <li>· Set & update from the dashboard</li>
              <li>· Charged per AI request</li>
              <li>· Paid straight to your Stellar wallet</li>
            </ul>
          </div>

          <div className="surface-card p-8 ring-2 ring-[var(--color-stellar-yellow)]">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-500)]">
                Platform fee
              </p>
              <span className="tag-chip bg-[var(--color-stellar-yellow)]">Flat</span>
            </div>
            <p className="mt-3 text-4xl font-semibold">0.001</p>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">USDC per settled request</p>
            <ul className="mt-6 space-y-2 text-sm text-[var(--color-ink-700)]">
              <li>· Split on-chain by paywall_core</li>
              <li>· You keep price − fee, always</li>
              <li>· We sponsor XLM gas on the spec rail</li>
            </ul>
          </div>

          <div className="surface-card p-8">
            <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-ink-500)]">
              Two payment rails
            </p>
            <p className="mt-3 text-4xl font-semibold">x402</p>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">any agent can pay</p>
            <ul className="mt-6 space-y-2 text-sm text-[var(--color-ink-700)]">
              <li>· Soroban USDC — spec-compliant MCP</li>
              <li>· Classic USDC — Verivyx SDK</li>
              <li>· Stellar Testnet + Mainnet</li>
            </ul>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-[var(--color-cream-200)]">
        <div className="mx-auto max-w-7xl px-6 py-20">
          <div className="surface-card relative overflow-hidden p-10 md:p-16">
            <div className="absolute inset-0 hero-mesh opacity-70" aria-hidden />
            <div className="relative grid items-center gap-8 md:grid-cols-2">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
                  Stop giving away your text. Start charging.
                </h2>
                <p className="mt-4 text-base text-[var(--color-ink-500)]">
                  Deploy in under 10 minutes. Drop a script tag, register your Stellar wallet, and
                  ship.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 md:justify-end">
                <Link href="/register" className="btn-yellow">
                  Create creator account <ArrowRight size={18} />
                </Link>
                <Link href="/login" className="btn-ghost">
                  Login
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
