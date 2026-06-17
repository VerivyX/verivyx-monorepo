import type { Metadata } from 'next';
import { Lead, H2, H3, P, Ul, Li, C, A, Note, Table } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'How agents pay (x402) — Verivyx Docs' };

export default function X402Docs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">How agents pay (x402)</h1>
      <Lead>
        Verivyx implements the <strong>x402</strong> protocol (version 2). An agent that wants a
        protected resource receives a machine-readable <C>402 Payment Required</C>, settles a USDC
        payment on Stellar, and retries — no human, no API key, no account. This page is the complete
        protocol reference; for the runnable narrative see the{' '}
        <A href="https://playground.verivyx.com">Playground</A>.
      </Lead>

      <H2 id="flow">The flow</H2>
      <Ul>
        <Li>The agent requests a protected URL and receives <C>402 Payment Required</C> with a <C>PAYMENT-REQUIRED</C> header — a base64 payload describing exactly how to pay.</Li>
        <Li>The agent picks one of the offered requirements, signs a USDC payment that satisfies it, and retries the request with a <C>PAYMENT-SIGNATURE</C> header.</Li>
        <Li>Verivyx verifies the payment on Stellar, the <C>paywall_core</C> contract splits it between creator and platform, and the content is returned with <C>200 OK</C> plus a <C>PAYMENT-RESPONSE</C> header.</Li>
      </Ul>

      <CodeBlock
        lang="http"
        code={`# 1. Request the protected resource
GET https://your-domain.com/article
→ 402 Payment Required
  PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi4u   # x402 requirements (base64)

# 2. Sign a USDC payment, then retry with the signature
GET https://your-domain.com/article
  PAYMENT-SIGNATURE: <signed x402 payload>     # base64
→ 200 OK                                       # content unlocked
  PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLi4u   # settlement result (base64)`}
      />

      <H2 id="headers">HTTP headers</H2>
      <Table
        head={['Header', 'Direction', 'Meaning']}
        rows={[
          [<C key="h">PAYMENT-REQUIRED</C>, 'Response (402)', <>Base64 of the <C>PaymentRequired</C> body — how to pay.</>],
          [<C key="h">X-Payment-Required</C>, 'Response (402)', 'Same payload; backward-compatible alias.'],
          [<C key="h">PAYMENT-SIGNATURE</C>, 'Request (retry)', 'Base64 of the signed payment payload (x402 v2).'],
          [<C key="h">X-PAYMENT</C>, 'Request (retry)', 'Legacy alias for the signed payload; also accepted.'],
          [<C key="h">PAYMENT-RESPONSE</C>, 'Response (200)', 'Base64 of the settlement result (transaction hashes, split).'],
        ]}
      />

      <H2 id="requirements">The 402 body (PaymentRequired)</H2>
      <P>
        The decoded <C>PAYMENT-REQUIRED</C> header is a JSON <C>PaymentRequired</C> object. It advertises
        one or more <C>accepts[]</C> options — pay <em>any one</em> of them.
      </P>
      <Table
        head={['Field', 'Type', 'Description']}
        rows={[
          [<C key="f">x402Version</C>, 'number', <>Protocol version. Always <C>2</C>.</>],
          [<C key="f">error</C>, 'string', 'Human-readable reason the request was rejected.'],
          [<C key="f">resource</C>, 'object', <>The resource being gated — <C>{'{ url, mimeType }'}</C>.</>],
          [<C key="f">accepts[]</C>, 'array', 'The payment options (see below). Satisfy one to unlock.'],
          [<C key="f">extensions</C>, 'object', <>Verivyx adds a <C>facilitator</C> hint: <C>{'{ scheme, url, version }'}</C> pointing at the hydrate endpoint to retry against.</>],
        ]}
      />
      <H3 id="accepts">Each accepts[] entry</H3>
      <Table
        head={['Field', 'Description']}
        rows={[
          [<C key="a">scheme</C>, <>Payment scheme. Verivyx uses <C>exact</C> (pay the exact amount).</>],
          [<C key="a">network</C>, <>CAIP-2 network id, e.g. <C>stellar:testnet</C>.</>],
          [<C key="a">amount</C>, <>Price in atomic USDC units (also mirrored as <C>maxAmountRequired</C>).</>],
          [<C key="a">asset</C>, <>The USDC asset: a Soroban contract id, or classic <C>USDC:&lt;issuer&gt;</C>.</>],
          [<C key="a">payTo</C>, 'Destination: the paywall contract (Soroban) or the creator account (classic).'],
          [<C key="a">maxTimeoutSeconds</C>, 'How long the quote is valid before it must be re-fetched.'],
          [<C key="a">extra</C>, <>Split details (<C>distribution</C> / <C>splitPayments</C>), <C>areFeesSponsored</C>, <C>domain</C>, and <C>paywallContract</C>.</>],
        ]}
      />

      <H2 id="rails">Payment rails</H2>
      <P>Every 402 advertises two equivalent rails so any x402 client can pay:</P>
      <Table
        head={['', 'Soroban USDC', 'Classic USDC']}
        rows={[
          ['Asset', <>Soroban USDC contract (SAC)</>, <C key="c">USDC:&lt;issuer&gt;</C>],
          ['Pays to', 'paywall_core contract', "Creator's Stellar account"],
          ['Split', 'On-chain by the contract', 'Two payment operations'],
          ['Network gas', 'Sponsored by Verivyx — no XLM needed', 'Paid by the agent'],
        ]}
      />
      <P>Amounts are always atomic, 7-decimal units: <C>1 USDC = 10,000,000</C>. A 0.05 USDC price is <C>500000</C>.</P>

      <H2 id="status">Status codes</H2>
      <Table
        head={['Code', 'When']}
        rows={[
          [<C key="s">200</C>, 'Payment accepted (or already paid / verified human) — content returned.'],
          [<C key="s">402</C>, 'Payment required, or the supplied payment was invalid — body carries fresh requirements.'],
          [<C key="s">404</C>, 'Domain not registered with Verivyx.'],
          [<C key="s">502</C>, <>Fail-closed: the upstream content could not be fetched (<C>content_unavailable</C>) — never leaks partial content.</>],
        ]}
      />

      <H2 id="standards">Standards &amp; compatibility</H2>
      <Ul>
        <Li>Verivyx is <strong>x402 v2</strong>-compliant and interoperates with generic x402 clients — see the <A href="https://x402.org">x402 specification</A> and the reference implementation from <A href="https://github.com/coinbase/x402">Coinbase&apos;s x402 project</A>.</Li>
        <Li>Payments settle on <A href="https://developers.stellar.org">Stellar</A> in USDC; networks are identified with CAIP-2 ids (<C>stellar:testnet</C>, <C>stellar:pubnet</C>).</Li>
        <Li>Both the standard header (<C>PAYMENT-SIGNATURE</C>) and the legacy alias (<C>X-PAYMENT</C>) are accepted, so older clients keep working.</Li>
      </Ul>

      <H2 id="today">What can pay today</H2>
      <P>
        Any spec-compliant x402 client can pay a Verivyx paywall right now. The fastest way to see a real
        end-to-end payment is the <A href="https://playground.verivyx.com">Playground</A>, where a sandboxed
        agent pays both a demo paywall and a real protected post on testnet and shows every step on-chain.
        To wire an AI agent up directly, use the <A href="/docs/mcp">x402 MCP server</A>.
      </P>

      <Note>
        Prefer code? The <A href="/docs/payment-api">Payment &amp; content API</A> documents every endpoint,
        and the <A href="/docs/api">interactive Swagger reference</A> has full request/response schemas.
      </Note>
    </article>
  );
}
