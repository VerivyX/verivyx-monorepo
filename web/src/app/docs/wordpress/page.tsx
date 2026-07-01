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
        Run WordPress? Install the Verivyx Paywall plugin, activate it, and connect your account. Once the
        paywall is on, add the small embed gate snippet so human visitors get the in-browser unlock — AI
        agents get a <C>402</C> and pay.
      </Lead>

      <H2 id="install">Install</H2>
      <Ul>
        <Li><strong>Create your Verivyx account</strong> and finish onboarding (wallet + token) — <A href="/register">register here</A>.</Li>
        <Li><strong>Download the plugin</strong> from your dashboard: <A href="/dashboard/integrations">Set up integration</A> → <strong>Download WordPress plugin</strong>. The download lives in your account.</Li>
        <Li>In WordPress: <strong>Plugins → Add New → Upload Plugin</strong>, choose <C>verivyx-paywall.zip</C>, then <strong>Install</strong> and <strong>Activate</strong>.</Li>
      </Ul>

      <H2 id="done">Turn on the paywall</H2>
      <P>
        On activation the plugin auto-detects your site and points at Verivyx — no API keys or IDs to paste.
        Once the paywall is enabled, the plugin withholds the article body from unverified clients: AI agents
        hitting your posts and pages receive a <C>402</C> and must settle a USDC micropayment.
      </P>

      <H2 id="human-gate">Let human visitors in</H2>
      <P>
        Content withholding turns on with the paywall, so real readers won&apos;t see the article until they
        pass the in-browser proof-of-work. Add the Verivyx embed gate snippet to your theme (from{' '}
        <A href="/dashboard/integrations">Set up integration</A>) so human visitors get the silent PoW unlock.
        See the <A href="/docs/embed">embed script guide</A> for the exact tag and the required content
        container.
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
        The plugin handles server-side content withholding and the <C>402</C> for agents, but it does not
        inject the client gate script — it shows you the embed snippet to copy into your theme. Add that
        snippet so human visitors get the silent PoW unlock. See <A href="/docs/embed">the embed script guide</A>{' '}
        and <A href="/docs/x402">How agents pay</A>.
      </Note>

      <div className="mt-12 border-t border-[var(--color-cream-200)] pt-6">
        <Link href="/register" className="btn-yellow text-sm">
          Register to download the plugin <ArrowRight size={16} />
        </Link>
      </div>
    </article>
  );
}
