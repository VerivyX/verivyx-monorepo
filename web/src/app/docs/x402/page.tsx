import type { Metadata } from 'next';
import { Lead, H2, P, Ul, Li, C, A, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'How agents pay (x402) — Verivyx Docs' };

export default function X402Docs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Guides</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">How agents pay (x402)</h1>
      <Lead>
        Verivyx speaks the x402 protocol (version 2). An agent that wants a protected resource gets a
        machine-readable <C>402 Payment Required</C>, settles a USDC payment on Stellar, and retries —
        all without a human in the loop.
      </Lead>

      <H2 id="flow">The flow</H2>
      <Ul>
        <Li>The agent requests a protected URL and receives <C>402 Payment Required</C> with a <C>PAYMENT-REQUIRED</C> header — a base64 payload describing how to pay (scheme, network, asset, amount, destination).</Li>
        <Li>The agent signs a USDC transfer that satisfies the requirements and retries the request with a <C>PAYMENT-SIGNATURE</C> header.</Li>
        <Li>Verivyx verifies the payment on Stellar, the <C>paywall_core</C> contract splits it between creator and platform, and the content is returned with <C>200 OK</C>.</Li>
      </Ul>

      <CodeBlock
        lang="http"
        code={`# 1. Request the protected resource
GET https://your-domain.com/article
→ 402 Payment Required
  PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi4u   # x402 requirements (base64)

# 2. Sign a USDC payment, then retry with the signature
GET https://your-domain.com/article
  PAYMENT-SIGNATURE: <signed x402 payload>
→ 200 OK                                       # content unlocked`}
      />

      <H2 id="rails">Payment rails</H2>
      <Ul>
        <Li><strong>Soroban USDC</strong> — spec-compliant Stellar payments. Gas is sponsored, so agents don&apos;t need XLM to pay.</Li>
        <Li><strong>Classic USDC</strong> — standard Stellar payments for clients that prefer the classic asset.</Li>
        <Li>Amounts are always in atomic units — <C>1 USDC = 10,000,000</C>.</Li>
      </Ul>

      <H2 id="today">What can pay today</H2>
      <P>
        Any spec-compliant x402 client can pay a Verivyx paywall right now. The fastest way to see a real
        end-to-end payment is the <A href="https://playground.verivyx.com">Playground</A>, where a sandboxed
        agent pays a demo paywall on testnet and shows every step on-chain.
      </P>

      <Note>
        First-party tooling is on the way — a Verivyx <A href="/docs/roadmap">MCP server and SDK</A> to make
        agent integration a few lines of code.
      </Note>
    </article>
  );
}
