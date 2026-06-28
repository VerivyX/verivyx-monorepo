import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, H3, P, Ul, Li, A, C, Note, Table } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'SDK (any framework) — Verivyx Docs' };

const nextMiddleware = `// proxy.ts — one file gates your whole Next.js app.
import { verivyxProxy } from "@verivyx/paywall-next";

export const proxy = verivyxProxy({
  match: ["/articles/:path*"],           // which paths to gate
  seoPreview: ({ slug }) => {            // teaser for crawlers + humans
    const a = getArticleSync(slug);
    return { title: a.title, excerpt: a.excerpt };
  },
  humanUnlock: {},                       // humans solve an in-page PoW → read free
});

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };`;

const expressMiddleware = `import express from "express";
import { verivyxMiddleware } from "@verivyx/paywall-express";

const app = express();
app.set("trust proxy", true);

app.use(verivyxMiddleware({
  match: ["/articles/*"],
  seoPreview: ({ slug }) => ({ title: titleFor(slug), excerpt: excerptFor(slug) }),
  humanUnlock: {},
}));

app.get("/articles/:slug", (req, res) => res.send(renderArticle(req.params.slug)));
app.listen(3000);`;

const honoMiddleware = `import { Hono } from "hono";
import { verivyxHonoMiddleware } from "@verivyx/paywall-hono";

const app = new Hono();

app.use("*", verivyxHonoMiddleware({
  match: ["/articles/*"],
  seoPreview: ({ slug }) => ({ title: titleFor(slug), excerpt: excerptFor(slug) }),
  humanUnlock: {},
}));

app.get("/articles/:slug", (c) => c.html(renderArticle(c.req.param("slug"))));
export default app;`;

const routeSnippet = `import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();   // reads VERIVYX_TOKEN / VERIVYX_DOMAIN

// Per-route alternative: wrap a single handler instead of using middleware.
export const GET = vx.protect(
  async (_req, ctx) => Response.json(await getArticle((await ctx.params).slug)),
  { seoPreview: ({ slug }) => ({ title: titleFor(slug), excerpt: excerptFor(slug) }) },
);`;

const envSnippet = `VERIVYX_TOKEN=…              # required — server-only secret, never ship to the browser
VERIVYX_DOMAIN=example.com   # required — must match the domain registered in the dashboard
VERIVYX_API_BASE=https://api.verivyx.com   # optional (this is the default)`;

export default function SdkDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">SDK (any framework)</h1>
      <Lead>
        One middleware file — <C>verivyxProxy</C> (Next), <C>verivyxMiddleware</C> (Express), or{' '}
        <C>verivyxHonoMiddleware</C> (Hono) — gates your whole app. Humans read for free, verified search
        crawlers get an SEO preview, AI agents pay via x402, and your content never leaves your server unless
        Verivyx confirms the request is authorised.
      </Lead>

      <H2 id="model">Authorize-only model</H2>
      <P>
        The SDK does not proxy or cache your content. It inspects every incoming request, checks the
        caller&apos;s identity and payment proof with the Verivyx API, and either lets the request reach your
        app or answers it itself (a 402 for unpaid agents, a teaser for crawlers, an unlock page for humans).
        Verivyx only ever sees the domain, the route slug, and the proof-of-payment or verification token —
        the full resource body stays on your server. Unauthorised callers never reach the route that renders
        it, so scrapers and bots never receive the content.
      </P>

      <H2 id="setup">Set up your domain first</H2>
      <P>
        Before adding the SDK, register your domain and get a <C>VERIVYX_TOKEN</C> from the dashboard. The
        token is scoped to your domain and authorises the SDK to call the Verivyx API on your behalf.
      </P>
      <div className="mt-4">
        <Link href="/dashboard/integrations?tab=sdk" className="btn-yellow text-sm inline-flex items-center gap-2">
          Open the SDK setup wizard <ArrowRight size={16} />
        </Link>
      </div>
      <P>
        The wizard: add your domain, prove ownership with a DNS TXT record
        (<C>verivyx-site-verification=&lt;code&gt;</C> on your domain), then copy your token. You can re-issue
        the token any time.
      </P>

      <H2 id="middleware">Recommended: one middleware file</H2>
      <P>
        The simplest integration is a single middleware that gates every matched route — no per-route code.
        Install the adapter for your framework and add one file. The middleware is the authoritative gate: it
        withholds content from bots (they never reach the page), settles agent x402 payments inline, lets
        verified humans through, and serves crawlers an SEO preview.
      </P>

      <H3 id="middleware-next">Next.js (App Router)</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-next" />
      <P>Add a <C>proxy.ts</C> at your project root:</P>
      <CodeBlock lang="ts" code={nextMiddleware} />

      <H3 id="middleware-express">Express</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-express" />
      <CodeBlock lang="ts" code={expressMiddleware} />

      <H3 id="middleware-hono">Hono (Cloudflare Workers / Vercel Edge)</H3>
      <CodeBlock lang="sh" code="npm i @verivyx/paywall-hono" />
      <CodeBlock lang="ts" code={honoMiddleware} />
      <P>
        For Workers, set secrets with <C>wrangler secret put VERIVYX_TOKEN</C> /{' '}
        <C>wrangler secret put VERIVYX_DOMAIN</C>, then <C>wrangler deploy</C>.
      </P>

      <H2 id="route-handler">Alternative: per-route handler</H2>
      <P>
        Prefer to gate a single API route instead of the whole app? Wrap one handler with{' '}
        <C>vx.protect(handler)</C>. Same gate, scoped to that route — handy for a paid JSON endpoint:
      </P>
      <CodeBlock lang="ts" code={routeSnippet} />
      <P>
        The Express and Hono adapters expose the same <C>vx.protect(handler)</C> for a single route.
      </P>

      <H2 id="human-unlock">Humans read for free (humanUnlock)</H2>
      <P>
        Set <C>humanUnlock: {'{}'}</C> and an unverified human in a real browser gets a small in-page
        proof-of-work challenge that auto-solves in their browser, sets a short-lived session, and reveals the
        full article — no payment, no login. Crawlers still get the SEO teaser; non-browser clients and AI
        agents still get a 402. This is a deterrent against casual scrapers, not a hard wall — the unspoofable
        guarantees are payment (x402) and signed agents (Web Bot Auth).
      </P>
      <Note>
        Without <C>humanUnlock</C>, unverified humans get the static teaser (the <C>seoPreview</C>) — useful
        as a soft paywall. With it, they can unlock the full content.
      </Note>

      <H2 id="config">Configuration</H2>
      <P>The required config comes from environment variables (or pass any option to the factory):</P>
      <CodeBlock lang="sh" code={envSnippet} />
      <Table
        head={['Option', 'Type', 'Default', 'Description']}
        rows={[
          [<><C>token</C> / <C>VERIVYX_TOKEN</C></>, 'string', '—', 'Required. Your domain token from the dashboard. Server-only — never expose to the browser.'],
          [<><C>domain</C> / <C>VERIVYX_DOMAIN</C></>, 'string', '—', 'Required. The domain you registered in Verivyx (e.g. example.com).'],
          [<C>match</C>, 'string[]', <C>[]</C>, 'Glob patterns for paths to gate. When empty, nothing is gated — set at least one. Env VERIVYX_MATCH accepts a comma-separated list.'],
          [<C>seoPreview</C>, '({ slug }) => { title, excerpt }', '—', 'Teaser served to crawlers (and to unverified humans without humanUnlock), wrapped in anti-cloaking JSON-LD.'],
          [<C>humanUnlock</C>, '{ authBase? }', '—', 'When set, unverified human browsers get an in-page PoW unlock to read the full content free.'],
          [<><C>failMode</C> / <C>VERIVYX_FAIL_MODE</C></>, <><C>teaser</C> | <C>open</C> | <C>closed</C></>, <C>teaser</C>, 'Behaviour when the Verivyx backend is unreachable (see below).'],
          [<><C>timeoutMs</C> / <C>VERIVYX_TIMEOUT_MS</C></>, 'number', <C>800</C>, 'Timeout (ms) for the quick classify/requirements call that decides how a caller is handled.'],
          [<><C>settleTimeoutMs</C> / <C>VERIVYX_SETTLE_TIMEOUT_MS</C></>, 'number', <C>60000</C>, 'Timeout (ms) for the authorize/settle call that awaits the on-chain payment. Kept separate so a paying agent is never aborted mid-settle.'],
        ]}
      />
      <Note>
        <strong>Two timeouts, by design.</strong> <C>timeoutMs</C> (default <C>800</C>) bounds the fast
        classify call for humans and crawlers, while <C>settleTimeoutMs</C> (default <C>60000</C>) covers the
        x402 authorize/settle path that waits for on-chain confirmation (~15s). Because the settle path has its
        own generous timeout, you do <strong>not</strong> need to raise <C>timeoutMs</C> when you accept agent
        payments — a paying agent is no longer aborted mid-settle.
      </Note>

      <H2 id="fail-mode">failMode behaviour</H2>
      <Table
        head={['failMode', 'Behaviour when the backend is unreachable']}
        rows={[
          [<C>teaser</C>, 'Serve the seoPreview (if configured) or a 402. Protects revenue while keeping the page indexable.'],
          [<C>open</C>, 'Pass the request through to your app unconditionally. Use only when availability outweighs monetisation.'],
          [<C>closed</C>, 'Return 503. Use for high-value content where accidental open access is unacceptable.'],
        ]}
      />

      <H2 id="callers">How different callers are handled</H2>
      <Ul>
        <Li>
          <strong>Humans (real browsers)</strong> — with <C>humanUnlock</C>, they get an in-page PoW unlock →
          full content free. Without it, they get the <C>seoPreview</C> teaser. A returning human with a valid
          session passes straight through.
        </Li>
        <Li>
          <strong>Verified search crawlers</strong> — Googlebot, Bingbot, and others on Verivyx&apos;s
          IP-range allowlist receive the <C>seoPreview</C> (title, excerpt, JSON-LD <C>isAccessibleForFree</C>)
          rather than the full body — satisfying Google&apos;s anti-cloaking rules.
        </Li>
        <Li>
          <strong>AI agents / machine clients</strong> — receive <C>402 Payment Required</C> with x402
          payment requirements. Agents that implement <A href="/docs/x402">x402</A> settle a USDC
          micropayment on-chain and retry; the SDK verifies the proof and admits the request.
        </Li>
        <Li>
          <strong>Paid / verified requests</strong> — requests carrying a valid payment proof or human session
          receive the full resource, exactly as if the SDK were not there.
        </Li>
      </Ul>

      <H2 id="security">Security note</H2>
      <Note>
        <strong>Keep <C>VERIVYX_TOKEN</C> server-only.</strong> Never include it in client bundles, expose it
        via <C>NEXT_PUBLIC_</C>, or log it. It is a bearer credential scoped to your domain. If it leaks,
        re-issue it from the dashboard — old tokens are invalidated the moment a new one is issued.
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
