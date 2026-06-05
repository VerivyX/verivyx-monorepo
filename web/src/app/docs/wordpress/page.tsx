import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, P, Ul, Li, A, C, Note } from '@/components/docs/Prose';

export const metadata: Metadata = { title: 'WordPress plugin — Verivyx Docs' };

export default function WordPressDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">WordPress plugin</h1>
      <Lead>
        Run WordPress? Skip the script tag entirely. Install the Verivyx Paywall plugin, activate it, and
        you&apos;re done — no code, nothing to configure. Humans read free, AI agents pay.
      </Lead>

      <H2 id="install">Install</H2>
      <Ul>
        <Li><strong>Create your Verivyx account</strong> and finish onboarding (domain + wallet) — <A href="/register">register here</A>.</Li>
        <Li><strong>Download the plugin</strong> from your dashboard: <strong>Get Script → Download WordPress plugin</strong>. The download lives in your account.</Li>
        <Li>In WordPress: <strong>Plugins → Add New → Upload Plugin</strong>, choose <C>verivyx-paywall.zip</C>, then <strong>Install</strong> and <strong>Activate</strong>.</Li>
      </Ul>

      <H2 id="done">That&apos;s it</H2>
      <P>
        On activation the plugin auto-detects your site&apos;s domain and points at Verivyx — no API keys, no
        IDs to paste. From that moment, AI agents hitting your posts and pages must settle a USDC
        micropayment, while real readers see no difference.
      </P>

      <H2 id="optional">Optional settings</H2>
      <P>
        Everything works out of the box, but <strong>Settings → Verivyx</strong> lets you fine-tune:
      </P>
      <Ul>
        <Li><strong>Protect</strong> — Posts, Pages, Posts + Pages, all singular content, or specific custom post types.</Li>
        <Li><strong>Paywall enabled</strong> — pause or resume the paywall any time.</Li>
        <Li><strong>Domain / API URL</strong> — pre-filled automatically; only change them if your setup is non-standard.</Li>
      </Ul>

      <Note>
        The plugin injects the same Verivyx gate the script tag would — so the underlying behavior (silent
        human check, 402 for agents, on-chain settlement) is identical. See <A href="/docs/x402">How agents pay</A>.
      </Note>

      <div className="mt-12 border-t border-[var(--color-cream-200)] pt-6">
        <Link href="/register" className="btn-yellow text-sm">
          Register to download the plugin <ArrowRight size={16} />
        </Link>
      </div>
    </article>
  );
}
