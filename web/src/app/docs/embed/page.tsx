import type { Metadata } from 'next';
import { Lead, H2, P, Ul, Li, C, A, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'Embed script — Verivyx Docs' };

export default function EmbedDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Embed script</h1>
      <Lead>
        A single script tag puts Verivyx in front of your pages. It runs the human check and the bot gate
        client-side, then talks to the Verivyx API to deliver or withhold content.
      </Lead>

      <Note>
        On WordPress? You don&apos;t need this tag — install the <A href="/docs/wordpress">Verivyx plugin</A>,
        activate it, and the gate is added for you (no code).
      </Note>

      <H2 id="tag">The tag</H2>
      <CodeBlock
        lang="html"
        code={`<script
  src="https://api.verivyx.com/gate.min.js"
  data-domain="your-domain.com"
  data-api="https://api.verivyx.com"
  async
></script>`}
      />

      <H2 id="attributes">Attributes</H2>
      <Ul>
        <Li><C>src</C> — the Verivyx gate script. Always loaded from <C>api.verivyx.com/gate.min.js</C>.</Li>
        <Li><C>data-domain</C> — the domain you registered in Verivyx. Must match exactly; this is how Verivyx looks up your pricing and wallet.</Li>
        <Li><C>data-api</C> — the Verivyx API base URL (<C>https://api.verivyx.com</C>).</Li>
        <Li><C>async</C> — load without blocking your page render.</Li>
      </Ul>

      <H2 id="placement">Placement</H2>
      <Ul>
        <Li>Add the tag <strong>once per domain</strong>, not once per page — it applies to your whole property.</Li>
        <Li>Place it just before the closing <C>{'</body>'}</C> tag.</Li>
        <Li>Get the exact, pre-filled snippet from <A href="/dashboard/integrations">Set up integration</A>.</Li>
      </Ul>

      <H2 id="container">Required content container</H2>
      <P>
        The gate hydrates the real article into an element with the id <C>vx-article</C>. Wrap the content
        you want to protect in that container — if no element with <C>id=&quot;vx-article&quot;</C> exists,
        the hydrate script silently no-ops and verified humans never see the body.
      </P>
      <CodeBlock
        lang="html"
        code={`<article id="vx-article">
  <!-- your article body -->
</article>`}
      />
      <Note>
        Only one <C>#vx-article</C> element is needed, on the pages you protect. The server fills it in for
        verified humans; for agents it stays withheld and the origin returns <C>402</C>.
      </Note>

      <H2 id="behavior">What it does</H2>
      <Ul>
        <Li>Runs a silent proof-of-work and fingerprint check to distinguish humans from agents — no captcha for real users.</Li>
        <Li>For verified humans, content is hydrated normally.</Li>
        <Li>For unverified/agent traffic, the origin responds with <C>402 Payment Required</C> and x402 payment requirements instead of your content.</Li>
      </Ul>

      <Note>
        The script is a gate, not the security boundary. The real protection is the server-side hydration
        check plus on-chain payment verification — never put secrets or access logic in the client.
      </Note>

      <P>
        Curious what happens on the agent side of that 402? See <A href="/docs/x402">How agents pay (x402)</A>.
      </P>
    </article>
  );
}
