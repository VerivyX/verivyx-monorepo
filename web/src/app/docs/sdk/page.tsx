import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, H3, P, Ul, Li, A, C, Note, Table } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'SDK (any framework) — Verivyx Docs' };

const nextSnippet = `import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();           // reads VERIVYX_TOKEN / VERIVYX_DOMAIN

export const GET = vx.protect(async (_req, ctx) => {
  const { slug } = (await ctx.params) ?? {};
  return Response.json(await getArticle(slug));
});`;

const nextProxySnippet = `import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();

// Route handler — content never leaves your server unless Verivyx says OK.
export const GET = vx.protect(
  async (_req, ctx) => {
    const { slug } = (await ctx.params) ?? {};
    return Response.json(await getArticle(slug));
  },
  {
    // Optional: pass an SEO preview for HTML pages so search engines
    // index a meaningful excerpt even when the full body is withheld.
    seoPreview: ({ slug }) => {
      const article = getArticleSync(slug);   // fetch by slug
      return { title: article.title, excerpt: article.excerpt };
    },
  },
);`;

const nextProxyFileSnippet = `// proxy.ts — Next.js coarse pre-filter (defense-in-depth only)
// The route handler (vx.protect) is the authoritative gate; this is additive.
import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();
export const proxy = vx.proxy();   // instance method, NOT a named export`;

const expressSnippet = `import express from "express";
import { verivyxExpress } from "@verivyx/paywall-express";

const vx = verivyxExpress();        // reads VERIVYX_TOKEN / VERIVYX_DOMAIN

const app = express();
app.get("/articles/:slug", vx.protect((req, res) =>
  res.json(getArticle(req.params.slug))
));
app.listen(3000);`;

const honoSnippet = `import { Hono } from "hono";
import { verivyxHono } from "@verivyx/paywall-hono";

const vx = verivyxHono();           // reads VERIVYX_TOKEN / VERIVYX_DOMAIN

const app = new Hono();
app.get("/articles/:slug", vx.protect((c) =>
  c.json(getArticle(c.req.param("slug")))
));
export default app;`;

const envSnippet = `VERIVYX_TOKEN=vx_live_…     # required — server-only secret, never ship to the browser
VERIVYX_DOMAIN=example.com   # required — must match the domain registered in the dashboard`;

const envFullSnippet = `VERIVYX_TOKEN=vx_live_…
VERIVYX_DOMAIN=example.com
VERIVYX_MATCH=articles/**,blog/**   # comma-separated glob list (default: empty — no routes matched)
VERIVYX_FAIL_MODE=teaser            # teaser | open | closed  (default: teaser)
VERIVYX_TIMEOUT_MS=800              # backend timeout in ms   (default: 800)`;

export default function SdkDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">SDK (any framework)</h1>
      <Lead>
        One function call — <C>vx.protect(handler)</C> — wraps your existing route handler and enforces the
        Verivyx gate. Humans pass through. Verified search crawlers get an SEO preview. AI agents pay via
        x402. Your content never leaves your server unless Verivyx confirms the request is authorised.
      </Lead>

      <H2 id="model">Authorize-only model</H2>
      <P>
        The SDK does not proxy or cache your content. It intercepts every incoming request, checks the
        caller&apos;s identity and payment proof with the Verivyx API, and either lets the request reach your
        handler or rejects it before your handler runs. Your database, your storage, your CDN — none of them
        are touched for requests that fail the gate. Verivyx only ever sees the domain, the route slug, and
        the proof-of-payment or verification token. The full resource body stays on your server.
      </P>
      <Note>
        This is the key difference from the embed script: the embed gates client-side after content is
        delivered; the SDK withholds content at the server level so scrapers and bots never receive it.
      </Note>

      <H2 id="setup">Set up your domain first</H2>
      <P>
        Before you add the SDK to your code, register your domain and get a <C>VERIVYX_TOKEN</C> from the
        dashboard. The token is scoped to your domain and authorises the SDK to call the Verivyx API on your
        behalf.
      </P>
      <div className="mt-4">
        <Link href="/dashboard/integrations?tab=sdk" className="btn-yellow text-sm inline-flex items-center gap-2">
          Open the SDK setup wizard <ArrowRight size={16} />
        </Link>
      </div>
      <P>
        The wizard walks you through three steps: add your domain, prove ownership via a
        well-known file, and get your token + ready-to-paste snippet. You can re-issue the token at any time
        if it is rotated or lost.
      </P>

      <H2 id="install-next">Next.js (App Router)</H2>
      <H3 id="install-next-pkg">Install</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-next" />
      <H3 id="install-next-usage">Route handler</H3>
      <P>
        Create a route handler at <C>app/articles/[slug]/route.ts</C> (or wherever your content lives). Wrap
        your existing handler with <C>vx.protect()</C>:
      </P>
      <CodeBlock lang="ts" code={nextSnippet} />
      <P>
        That is the minimum. For HTML pages that benefit from SEO indexing you can pass an optional{' '}
        <C>seoPreview</C> callback — the SDK serves the preview to verified search crawlers while withholding
        the full body from everyone else:
      </P>
      <CodeBlock lang="ts" code={nextProxySnippet} />
      <P>
        For defense-in-depth you can also add a <C>proxy.ts</C> pre-filter using <C>vx.proxy()</C> —
        an <em>instance method</em> on the adapter, not a separate named export. It sheds obvious
        unpaid-bot traffic before it reaches the route handler; the route handler remains the
        authoritative gate:
      </P>
      <CodeBlock lang="ts" code={nextProxyFileSnippet} />

      <H2 id="install-express">Express</H2>
      <H3 id="install-express-pkg">Install</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-express" />
      <H3 id="install-express-usage">Middleware</H3>
      <P>
        Pass your handler directly to <C>vx.protect()</C> — it returns Express-compatible middleware that
        runs the gate before your handler fires:
      </P>
      <CodeBlock lang="ts" code={expressSnippet} />

      <H2 id="install-hono">Hono (Cloudflare Workers / Vercel Edge)</H2>
      <H3 id="install-hono-pkg">Install</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-hono" />
      <H3 id="install-hono-usage">Route</H3>
      <P>
        The Hono adapter follows the same <C>vx.protect(handler)</C> pattern and works on Cloudflare Workers
        and Vercel Edge Functions without any Node.js-specific APIs:
      </P>
      <CodeBlock lang="ts" code={honoSnippet} />
      <P>
        For Workers, set your secrets with <C>wrangler secret put VERIVYX_TOKEN</C> and{' '}
        <C>wrangler secret put VERIVYX_DOMAIN</C>, then deploy with <C>wrangler deploy</C>.
      </P>

      <H2 id="config">Configuration</H2>
      <P>
        The SDK reads its config from environment variables by default. Set the two required variables in
        your <C>.env.local</C> (Next.js) or server environment:
      </P>
      <CodeBlock lang="sh" code={envSnippet} />
      <P>
        You can also pass any option directly to the factory function — the constructor argument takes
        precedence over the environment variable:
      </P>
      <CodeBlock lang="ts" code={`const vx = verivyxNext({\n  token: process.env.VERIVYX_TOKEN,\n  domain: "example.com",\n  match: ["articles/**", "blog/**"],\n  failMode: "teaser",\n  timeoutMs: 800,\n});`} />
      <P>Full list of options (all optional when the env vars are set):</P>
      <Table
        head={['Option / env var', 'Type', 'Default', 'Description']}
        rows={[
          [<><C>token</C> / <C>VERIVYX_TOKEN</C></>, 'string', '—', 'Required. Your domain token from the dashboard. Server-only — never expose this to the browser.'],
          [<><C>domain</C> / <C>VERIVYX_DOMAIN</C></>, 'string', '—', 'Required. The domain you registered in Verivyx (e.g. example.com).'],
          [<><C>match</C> / <C>VERIVYX_MATCH</C></>, 'string[]', <C>[]</C>, 'Array of glob patterns for routes to protect. When empty (the default) no routes are matched — set at least one pattern to enable the gate. The env var accepts a comma-separated list: articles/**,blog/**'],
          [<><C>failMode</C> / <C>VERIVYX_FAIL_MODE</C></>, <><C>teaser</C> | <C>open</C> | <C>closed</C></>, <C>teaser</C>, 'Behaviour when the Verivyx backend is unreachable. See the failMode table below.'],
          [<><C>timeoutMs</C> / <C>VERIVYX_TIMEOUT_MS</C></>, 'number', <C>800</C>, 'Backend request timeout in milliseconds. Requests that exceed this fall through to failMode.'],
        ]}
      />

      <H2 id="fail-mode">failMode behaviour</H2>
      <P>
        When the Verivyx API is unreachable (network error, timeout), the SDK falls back to the configured{' '}
        <C>failMode</C> rather than failing open or blocking all traffic:
      </P>
      <Table
        head={['failMode', 'Behaviour']}
        rows={[
          [<C>teaser</C>, 'Serve the seoPreview (if configured) or a minimal stub. Protects revenue while keeping the page indexable.'],
          [<C>open</C>, 'Pass the request through to your handler unconditionally. Use only when availability outweighs monetisation.'],
          [<C>closed</C>, 'Return 503 Service Unavailable. Use for high-value content where accidental open access is unacceptable.'],
        ]}
      />

      <H2 id="callers">How different callers are handled</H2>
      <P>
        The SDK classifies every incoming request before your handler runs:
      </P>
      <Ul>
        <Li>
          <strong>Humans</strong> — requests that carry a valid Verivyx proof-of-work token (set by the
          embed script or a prior session) pass straight through to your handler.
        </Li>
        <Li>
          <strong>Verified search crawlers</strong> — Googlebot, Bingbot, and other crawlers on Verivyx&apos;s
          IP-range allowlist are confirmed server-side. They receive the <C>seoPreview</C> response (title,
          excerpt, JSON-LD <C>isAccessibleForFree</C> markup) rather than the full body, satisfying
          Google&apos;s anti-cloaking requirements while withholding monetised content.
        </Li>
        <Li>
          <strong>AI agents / unknown bots</strong> — all other non-human traffic receives{' '}
          <C>402 Payment Required</C> with an x402 payment-requirements header. Agents that implement the{' '}
          <A href="/docs/x402">x402 protocol</A> settle a USDC micropayment on-chain and retry; the SDK
          verifies the on-chain proof and admits the request on success.
        </Li>
        <Li>
          <strong>Paid / verified requests</strong> — requests that carry a valid payment proof or a verified
          human token receive the full resource from your handler, exactly as if the SDK were not there.
        </Li>
      </Ul>

      <H2 id="seo-preview">SEO preview</H2>
      <P>
        Pass a <C>seoPreview</C> callback to <C>vx.protect()</C> to serve a meaningful excerpt to search
        crawlers. The callback receives the same request and context as your main handler and must return an
        object with at least <C>title</C> and <C>excerpt</C>. The SDK wraps the response in JSON-LD{' '}
        <C>isAccessibleForFree: false</C> markup so Google treats it as a metered-paywall page (no
        cloaking penalty):
      </P>
      <CodeBlock
        lang="ts"
        code={`export const GET = vx.protect(
  async (_req, ctx) => Response.json(await getArticle((await ctx.params).slug)),
  {
    // seoPreview receives { slug } — a sync callback, no req/ctx needed.
    seoPreview: ({ slug }) => {
      const a = getArticleSync(slug);   // look up the article by slug
      return { title: a.title, excerpt: a.excerpt };   // string fields
    },
  },
);`}
      />

      <H2 id="security">Security note</H2>
      <Note>
        <strong>Keep <C>VERIVYX_TOKEN</C> server-only.</strong> Never include it in client-side bundles,
        expose it via <C>NEXT_PUBLIC_</C> prefixes, or log it. The token is a bearer credential — anyone
        who holds it can make calls on behalf of your domain. Redact it from request logs and error
        reporting. If you suspect the token has been exposed, re-issue it from the dashboard immediately:
        old tokens are invalidated the moment a new one is issued.
      </Note>

      <div className="mt-12 border-t border-[var(--color-cream-200)] pt-6 flex gap-3 flex-wrap">
        <Link href="/dashboard/integrations?tab=sdk" className="btn-yellow text-sm inline-flex items-center gap-2">
          Get your domain token <ArrowRight size={16} />
        </Link>
        <Link href="/docs/x402" className="btn-outline text-sm inline-flex items-center gap-2">
          How agents pay (x402) <ArrowRight size={16} />
        </Link>
      </div>
    </article>
  );
}
