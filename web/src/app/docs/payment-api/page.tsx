import type { Metadata } from 'next';
import { Lead, H2, H3, P, C, A, Note, Table } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'Payment & content API — Verivyx Docs' };

export default function PaymentApi() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">API</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Payment &amp; content API</h1>
      <Lead>
        The money path: the x402 payment gateway tells agents how to pay and settles payments on
        Stellar, and the hydration service returns the real content to anyone who has paid or proven
        they&apos;re human. Base URL <C>https://api.verivyx.com</C>. See the{' '}
        <A href="/docs/x402">x402 flow guide</A> for the narrative, or the{' '}
        <A href="/docs/api">interactive reference</A> for full schemas.
      </Lead>

      <H2 id="endpoints">Endpoints at a glance</H2>
      <Table
        head={['Method & path', 'Auth', 'Purpose']}
        rows={[
          [<C key="e">GET /api/v1/payment/requirements</C>, 'None', 'Discover how to pay (returns the x402 402 body).'],
          [<C key="e">GET /api/v1/payment/quote</C>, 'None', 'Price, asset, network, and destination for a domain.'],
          [<C key="e">POST /api/v1/payment/verify</C>, 'None', 'Dry-run: validate a signed payment without submitting.'],
          [<C key="e">POST /api/v1/payment/settle</C>, 'None', 'Submit on-chain, split, and open a paid session.'],
          [<C key="e">GET /api/v1/payment/supported</C>, 'None', 'Supported schemes and networks.'],
          [<C key="e">GET /api/v1/payment/health</C>, 'None', 'Liveness probe.'],
          [<C key="e">POST /api/v1/content/hydrate</C>, 'x402 / human JWT / paid session', 'Return the real content to an authorized requester.'],
        ]}
      />

      <H2 id="gateway">Payment gateway</H2>

      <H3 id="requirements">Get payment requirements</H3>
      <P><C>GET /api/v1/payment/requirements?domain&amp;slug</C> — no auth. Returns the x402 <C>PaymentRequired</C> body and a <C>PAYMENT-REQUIRED</C> header (base64). Responds <C>402</C> when the paywall is on, <C>200</C> when off.</P>
      <CodeBlock
        lang="bash"
        code={`curl -i "https://api.verivyx.com/api/v1/payment/requirements?domain=example.com&slug=my-article"
# → 402 Payment Required
#   PAYMENT-REQUIRED: <base64 requirements>
#   { "x402Version": 2, "accepts": [ /* Soroban + classic USDC */ ], ... }`}
      />

      <H3 id="quote">Quote a price</H3>
      <P><C>GET /api/v1/payment/quote?domain</C> — no auth. Returns the price, atomic amount, asset, network, and destination for a domain.</P>

      <H3 id="verify">Verify a payment</H3>
      <P><C>POST /api/v1/payment/verify</C> — no auth. A dry run: validates a signed payment against the requirement without submitting it. Body is the x402 facilitator request.</P>
      <CodeBlock
        lang="bash"
        code={`curl https://api.verivyx.com/api/v1/payment/verify \\
  -H 'Content-Type: application/json' \\
  -d '{
    "x402Version": 2,
    "paymentPayload": { "x402Version": 2, "accepted": { ... }, "payload": { "transaction": "<xdr>", "payer": "G…" } },
    "paymentRequirements": { ... }
  }'
# → { "isValid": true, "payer": "G…" }`}
      />

      <H3 id="settle">Settle a payment</H3>
      <P>
        <C>POST /api/v1/payment/settle</C> — no auth. Submits the signed payment on-chain, splits creator/platform,
        and opens a one-hour paid session for the <C>(domain, slug)</C>. Pass an <C>Idempotency-Key</C> header to
        make retries safe — a repeat with the same key replays the cached result instead of charging again. The
        response also carries a <C>PAYMENT-RESPONSE</C> header.
      </P>
      <CodeBlock
        lang="bash"
        code={`curl https://api.verivyx.com/api/v1/payment/settle \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: 0f3c…unique' \\
  -d '{ "x402Version": 2, "paymentPayload": { … }, "paymentRequirements": { … } }'
# → { "success": true, "transaction": "…", "distributeTransaction": "…", "network": "stellar:testnet" }`}
      />

      <H3 id="supported">Supported &amp; health</H3>
      <P><C>GET /api/v1/payment/supported</C> returns the facilitator&apos;s supported schemes/networks. <C>GET /api/v1/payment/health</C> is a liveness probe.</P>

      <H2 id="hydration">Content hydration</H2>

      <H3 id="hydrate">Hydrate content</H3>
      <P>
        <C>POST /api/v1/content/hydrate</C> with body <C>{'{ domain, slug }'}</C>. Authorize with <strong>any</strong> of:
        an <C>X-PAYMENT</C>/<C>PAYMENT-SIGNATURE</C> header, an <C>Authorization: Bearer</C> human-session JWT, or an
        existing paid session from <C>/payment/settle</C>. On success the body includes <C>served</C>
        (<C>passthrough</C>, <C>paid_agent</C>, or <C>human</C>) and the article <C>html</C>.
      </P>
      <CodeBlock
        lang="bash"
        code={`# Agent that just settled retries the resource via hydrate:
curl https://api.verivyx.com/api/v1/content/hydrate \\
  -H 'Content-Type: application/json' \\
  -H 'PAYMENT-SIGNATURE: <signed x402 payload>' \\
  -d '{ "domain": "example.com", "slug": "my-article" }'
# → 200 { "status": "success", "served": "paid_agent", "html": "<p>…</p>" }
# → 402 (with x402 requirements) when no valid auth is present`}
      />
      <Note>
        Hydration is fail-closed: if the upstream body can&apos;t be fetched it returns
        <C>502 content_unavailable</C> rather than leaking partial content.
      </Note>
    </article>
  );
}
