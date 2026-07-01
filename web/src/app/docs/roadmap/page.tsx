import type { Metadata } from 'next';
import { Boxes, Code2 } from 'lucide-react';
import { Lead, H2, P, A } from '@/components/docs/Prose';

export const metadata: Metadata = { title: 'Roadmap — Verivyx Docs' };

export default function RoadmapDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">Resources</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Roadmap</h1>
      <Lead>
        Today any spec-compliant x402 agent can pay a Verivyx paywall. Next up: first-party tooling that
        makes integration effortless.
      </Lead>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {[
          {
            icon: <Boxes className="h-5 w-5" />,
            title: 'Verivyx MCP Server',
            status: 'Live (early access)',
            body: 'A first-party Model Context Protocol server so agents like Claude can discover Verivyx-protected resources and settle payments natively — no glue code.',
          },
          {
            icon: <Code2 className="h-5 w-5" />,
            title: 'Developer SDK',
            status: 'Coming soon',
            body: 'A drop-in TypeScript SDK to add x402 payments to your own agent in a few lines — handle the 402, sign the USDC transfer, retry, done.',
          },
        ].map((c) => (
          <div key={c.title} className="surface-card p-6">
            <div className="flex items-center justify-between">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]">
                {c.icon}
              </span>
              <span className="tag-chip bg-[var(--color-stellar-violet-soft)] text-[var(--color-ink-900)]">
                {c.status}
              </span>
            </div>
            <h3 className="mt-5 text-lg font-semibold">{c.title}</h3>
            <p className="mt-2 text-sm text-[var(--color-ink-500)]">{c.body}</p>
          </div>
        ))}
      </div>

      <H2 id="today">In the meantime</H2>
      <P>
        You don&apos;t have to wait to integrate. Point any x402-capable agent at a Verivyx paywall, or try
        the <A href="https://playground.verivyx.com">Playground</A> to watch a payment settle end-to-end on
        Stellar testnet.
      </P>
    </article>
  );
}
