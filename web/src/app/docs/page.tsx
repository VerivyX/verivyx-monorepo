import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, P, Ul, Li, A, C } from '@/components/docs/Prose';

export const metadata: Metadata = { title: 'Introduction — Verivyx Docs' };

export default function DocsIntro() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Getting started</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Introduction</h1>
      <Lead>
        Verivyx is a paywall for the agentic web. Humans read your content for free; AI agents pay a
        USDC micropayment over the x402 protocol on Stellar before they get a single token. Your
        content stays on your server — Verivyx only controls access.
      </Lead>

      <H2 id="model">The model</H2>
      <P>
        Verivyx&apos;s security is <strong>economic, not cryptographic</strong>. A scraper can read
        your HTML source, but it cannot complete an x402 payment. The goal isn&apos;t to defeat every
        bot — it&apos;s to make sophisticated AI agents that want legitimate, reliable access pay for
        it, automatically.
      </P>
      <Ul>
        <Li><strong>Humans browse free.</strong> A lightweight proof-of-work check runs silently — no captcha, no friction.</Li>
        <Li><strong>Agents pay per request.</strong> Unverified traffic gets an HTTP <C>402 Payment Required</C> with x402 payment requirements.</Li>
        <Li><strong>Settlement is on-chain.</strong> USDC settles on Stellar in seconds and is split between you and the platform by the <C>paywall_core</C> Soroban contract.</Li>
      </Ul>

      <H2 id="how">How it works</H2>
      <P>One script tag sits in front of your pages and runs three layers:</P>
      <Ul>
        <Li><strong>Detect</strong> — heuristics tell humans from agents (fingerprints, known agent UAs, behavior).</Li>
        <Li><strong>Hydrate</strong> — real text is never delivered to unverified sessions; bots get a 402, humans get content.</Li>
        <Li><strong>Settle</strong> — agents pay USDC over x402; Verivyx verifies the transaction on Stellar, then unlocks access.</Li>
      </Ul>

      <H2 id="next">Next steps</H2>
      <Ul>
        <Li><A href="/docs/quickstart">Quickstart</A> — create an account and go live in minutes.</Li>
        <Li><A href="/docs/embed">Embed script</A> — the one tag and its options.</Li>
        <Li><A href="/docs/wordpress">WordPress plugin</A> — one-click install, no code.</Li>
        <Li><A href="/docs/x402">How agents pay</A> — the x402 flow for agent developers.</Li>
        <Li><A href="/docs/api-overview">API</A> — REST endpoints for payments, content, and creators.</Li>
        <Li><A href="https://playground.verivyx.com">Playground</A> — watch an agent pay a paywall live.</Li>
      </Ul>

      <div className="mt-12 border-t border-[var(--color-cream-200)] pt-6">
        <Link href="/docs/quickstart" className="btn-yellow text-sm">
          Start the Quickstart <ArrowRight size={16} />
        </Link>
      </div>
    </article>
  );
}
