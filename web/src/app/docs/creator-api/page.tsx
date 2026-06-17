import type { Metadata } from 'next';
import { Lead, H2, H3, P, Ul, Li, C, A, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'Creator & auth API — Verivyx Docs' };

export default function CreatorApi() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">API</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Creator &amp; auth API</h1>
      <Lead>
        Accounts, content management, analytics, humanity verification, and the zero-config Connect
        handshake. Base URL <C>https://api.verivyx.com</C>. Creator endpoints require
        <C>Authorization: Bearer &lt;token&gt;</C>; see the <A href="/docs/api">interactive reference</A> for
        full schemas.
      </Lead>

      <H2 id="accounts">Accounts</H2>
      <Ul>
        <Li><C>POST /api/v1/auth/register</C> — <C>{'{ email, password, turnstileToken }'}</C>. Creates an unverified account and emails a verification link.</Li>
        <Li><C>POST /api/v1/auth/verify-email</C> — <C>{'{ token }'}</C>. Verifies and returns a session <C>token</C> + <C>user</C>.</Li>
        <Li><C>POST /api/v1/auth/resend-verification</C> — <C>{'{ email }'}</C>. Always returns success.</Li>
        <Li><C>POST /api/v1/auth/login</C> — <C>{'{ email, password, turnstileToken }'}</C>. Returns <C>token</C> + <C>user</C>. Email must be verified.</Li>
      </Ul>
      <CodeBlock
        lang="bash"
        code={`curl https://api.verivyx.com/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"…","turnstileToken":"…"}'
# → { "status": "success", "token": "<jwt>", "user": { … } }`}
      />

      <H2 id="profile">Profile &amp; payouts</H2>
      <Ul>
        <Li><C>GET /api/v1/auth/me</C> — the current creator.</Li>
        <Li><C>PATCH /api/v1/auth/settings</C> — update <C>pricePerRequest</C> (0.0001–1 USDC), <C>domain</C>, <C>stellar_address</C>, or <C>paywallEnabled</C>.</Li>
        <Li><C>GET /api/v1/auth/payout-status</C> — checks the creator&apos;s on-chain USDC trustline / payout readiness.</Li>
      </Ul>

      <H2 id="content">Content</H2>
      <Ul>
        <Li><C>GET /api/v1/auth/contents</C> — list content (metadata only).</Li>
        <Li><C>POST /api/v1/auth/contents</C> — <C>{'{ slug, title?, body, mimeType? }'}</C>. Body up to 200&nbsp;KB.</Li>
        <Li><C>GET /api/v1/auth/contents/&#123;slug&#125;</C> — one item with body.</Li>
        <Li><C>PATCH /api/v1/auth/contents/&#123;slug&#125;</C> — update title/body/mimeType.</Li>
        <Li><C>DELETE /api/v1/auth/contents/&#123;slug&#125;</C> — delete.</Li>
      </Ul>
      <CodeBlock
        lang="bash"
        code={`curl https://api.verivyx.com/api/v1/auth/contents \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"slug":"my-article","title":"My article","body":"<p>…</p>"}'
# → 201 { "content": { "id": 1, "slug": "my-article", … } }`}
      />

      <H2 id="analytics">Analytics &amp; transactions</H2>
      <Ul>
        <Li><C>GET /api/v1/auth/analytics</C> — a 7-day summary: totals, per-agent breakdown, recent activity, reputation signals, anomalies.</Li>
        <Li><C>GET /api/v1/auth/transactions?limit&amp;cursor</C> — settled payments, newest first. Page with <C>nextCursor</C>.</Li>
      </Ul>

      <H2 id="humanity">Humanity verification</H2>
      <P>
        A two-step proof-of-work flow used by the browser paywall to issue a human session (which the
        hydration service accepts). The difficulty adapts to the requester&apos;s reputation.
      </P>
      <Ul>
        <Li><C>POST /api/v1/auth/challenge</C> — <C>{'{ domain, slug }'}</C> → a signed <C>challenge</C>, <C>salt</C>, <C>difficulty</C>.</Li>
        <Li><C>POST /api/v1/auth/verify-human</C> — <C>{'{ challenge, nonce }'}</C> → <C>{'{ sessionToken, ttlSeconds }'}</C>.</Li>
      </Ul>

      <H2 id="connect">Connect handshake</H2>
      <P>
        The zero-config &quot;Connect to Verivyx&quot; flow that provisions a per-domain token (used by the
        WordPress plugin). OAuth-authorization-code style — the secret is only returned at the final
        server-to-server exchange.
      </P>
      <Ul>
        <Li><C>POST /api/v1/domains/connect/init</C> — <C>{'{ site }'}</C> → <C>{'{ connect_id, nonce }'}</C>.</Li>
        <Li><C>POST /api/v1/domains/connect/authorize</C> — Bearer; <C>{'{ connect_id }'}</C>. Verifies ownership via an SSRF-guarded callback and returns a one-time <C>code</C>.</Li>
        <Li><C>POST /api/v1/domains/connect/token</C> — <C>{'{ connect_id, code }'}</C> → <C>{'{ token }'}</C> (the per-domain internal token).</Li>
      </Ul>
      <Note>
        Also public: <C>POST /api/v1/mcp-waitlist</C> joins the MCP early-access waitlist
        (<C>{'{ email, turnstileToken }'}</C>).
      </Note>
    </article>
  );
}
