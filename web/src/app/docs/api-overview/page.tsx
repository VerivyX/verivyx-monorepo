import type { Metadata } from 'next';
import { Lead, H2, H3, P, Ul, Li, C, A, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'API overview — Verivyx Docs' };

export default function ApiOverview() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">API</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">API overview</h1>
      <Lead>
        Every Verivyx surface is an HTTP API. This page covers the base URLs, authentication, and
        conventions shared across them. For endpoints and schemas by area, see the{' '}
        <A href="/docs/payment-api">Payment &amp; content API</A> and the{' '}
        <A href="/docs/creator-api">Creator &amp; auth API</A>.
      </Lead>

      <H2 id="hosts">Hosts</H2>
      <Ul>
        <Li><C>https://api.verivyx.com</C> — REST API: payments, content hydration, auth &amp; creator, connect.</Li>
        <Li><C>https://mcp.verivyx.com</C> — the x402 MCP server for AI agents.</Li>
        <Li><C>https://playground.verivyx.com</C> — the sandboxed playground agent.</Li>
      </Ul>

      <H2 id="auth">Authentication</H2>
      <P>Different surfaces use different credentials:</P>
      <Ul>
        <Li><strong>Creator JWT</strong> — <C>Authorization: Bearer &lt;token&gt;</C>. Returned by login and email verification; required for creator and admin endpoints.</Li>
        <Li><strong>x402 payment</strong> — <C>X-PAYMENT</C> or <C>PAYMENT-SIGNATURE</C>, a signed Stellar payment. Used to unlock paid content.</Li>
        <Li><strong>Human session JWT</strong> — issued by <C>/auth/verify-human</C> after a proof-of-work challenge; lets a verified browser hydrate content.</Li>
        <Li><strong>MCP key</strong> — <C>X-Verivyx-MCP-Key</C> (or a Bearer key) for the MCP server.</Li>
      </Ul>
      <Note>
        Internal service-mesh endpoints (<C>X-Internal-Token</C>) and admin endpoints are not for
        public callers and are documented separately in the admin-gated internal reference.
      </Note>

      <H2 id="conventions">Conventions</H2>
      <Ul>
        <Li>Requests and responses are JSON unless noted (the playground chat streams Server-Sent Events).</Li>
        <Li>Errors return a non-2xx status with a body like <C>{'{ "error": "code", "detail": "..." }'}</C>.</Li>
        <Li>USDC amounts on the wire are atomic, 7-decimal units — <C>1 USDC = 10,000,000</C>.</Li>
        <Li>Several public endpoints are rate-limited per IP and gated by Cloudflare Turnstile.</Li>
        <Li>The payment surface follows the <A href="https://x402.org">x402 v2 specification</A> (<A href="https://github.com/coinbase/x402">Coinbase x402</A>) and settles on <A href="https://developers.stellar.org">Stellar</A>; networks use CAIP-2 ids such as <C>stellar:testnet</C>.</Li>
      </Ul>

      <H3 id="example">Quick example</H3>
      <CodeBlock
        lang="bash"
        code={`# Log in and call an authenticated endpoint
TOKEN=$(curl -s https://api.verivyx.com/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"…","turnstileToken":"…"}' \\
  | jq -r .token)

curl https://api.verivyx.com/api/v1/auth/me \\
  -H "Authorization: Bearer $TOKEN"`}
      />

      <H2 id="next">Where to next</H2>
      <Ul>
        <Li><A href="/docs/payment-api">Payment &amp; content API</A> — discover requirements, settle x402 payments, hydrate content.</Li>
        <Li><A href="/docs/creator-api">Creator &amp; auth API</A> — accounts, content management, analytics, the Connect handshake.</Li>
        <Li><A href="/docs/mcp">x402 MCP server</A> — let agents pay any x402 resource through Verivyx.</Li>
      </Ul>
    </article>
  );
}
