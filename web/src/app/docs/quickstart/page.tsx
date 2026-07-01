import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, P, Ul, Li, A, C, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'Quickstart — Verivyx Docs' };

export default function Quickstart() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Getting started</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Quickstart</h1>
      <Lead>Go from zero to a live, agent-paying paywall in a few minutes.</Lead>

      <H2 id="account">1. Create your account</H2>
      <P>
        <A href="/register">Register</A> with your email and a password. We send a verification link —
        click it to activate your account, then log in. (Wallet and pricing come next, not at signup.)
      </P>

      <H2 id="onboarding">2. Set your payout wallet and price</H2>
      <P>
        On first login you&apos;ll complete a short setup wizard — no domain, no DNS:
      </P>
      <Ul>
        <Li><strong>Payout wallet</strong> — paste an existing Stellar <C>G…</C> address or generate a fresh testnet one. USDC from agents settles straight here.</Li>
        <Li><strong>Price</strong> — set the USDC amount an agent pays per request. You can change it any time.</Li>
      </Ul>

      <H2 id="trustline">3. Activate your USDC wallet</H2>
      <P>
        Before your wallet can receive USDC it needs a one-time trustline. From your dashboard, open the
        <C>USDC wallet</C> card and click <strong>Enable USDC wallet</strong> — sign it with Freighter.
        Verivyx never touches your keys.
      </P>
      <Note>
        Your Stellar account needs a little XLM first (≈1 XLM) to cover the trustline reserve and fee.
      </Note>

      <H2 id="embed">4. Add the script tag</H2>
      <P>
        In the dashboard, open <A href="/dashboard/integrations">Set up integration</A> and copy your
        pre-configured tag. It looks like this — paste it once per site, just before <C>{'</body>'}</C>:
      </P>
      <CodeBlock
        lang="html"
        code={`<script
  src="https://api.verivyx.com/gate.min.js"
  data-domain="your-domain.com"
  data-api="https://api.verivyx.com"
  async
></script>`}
      />

      <H2 id="go-live">5. You&apos;re live</H2>
      <P>
        Humans keep browsing normally. AI agents that hit your pages now receive a <C>402</C> and must
        settle a USDC micropayment to get through — revenue flows directly to your Stellar wallet. You set
        the price per request and can pause the paywall any time from the dashboard.
      </P>

      <div className="mt-12 flex flex-wrap gap-3 border-t border-[var(--color-cream-200)] pt-6">
        <Link href="/docs/embed" className="btn-yellow text-sm">
          Embed script reference <ArrowRight size={16} />
        </Link>
        <a href="https://playground.verivyx.com" className="btn-ghost text-sm">
          See it in the Playground
        </a>
      </div>
    </article>
  );
}
