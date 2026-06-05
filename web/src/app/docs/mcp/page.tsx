import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { Lead, H2, P, Ul, Li, A, C, Note } from '@/components/docs/Prose';
import { CodeBlock } from '@/components/docs/CodeBlock';

export const metadata: Metadata = { title: 'x402 MCP server — Verivyx Docs' };

const CONFIG_EXAMPLE = `{
  "mcpServers": {
    "verivyx": {
      "type": "streamable-http",
      "url": "https://mcp.verivyx.com/mcp",
      "headers": { "X-Verivyx-MCP-Key": "vxmcp_your_key" }
    }
  }
}`;

const TOOL_CALL = `→ pay_for_resource("https://api.example.com/report")

  chain         solana:devnet
  resource      0.010 USDC
  service fee   0.001 USDC  → Verivyx
  status        200 OK · paid ✓`;

export default function McpDocs() {
  return (
    <article>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">For AI agents</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">x402 MCP server</h1>
      <Lead>
        One MCP connection that lets any AI agent pay for any x402-protected resource — across Stellar,
        Base, and Solana — without ever holding a private key.
      </Lead>

      <Note>
        <strong>Early access.</strong> The hosted server at <C>mcp.verivyx.com</C> is opening to early
        users. <A href="https://mcp.verivyx.com">Join the waitlist</A> to get a key.
      </Note>

      <H2 id="what">What it is</H2>
      <P>
        Verivyx MCP is a remote <A href="https://modelcontextprotocol.io">Model Context Protocol</A>{' '}
        server. Connect it to Claude, Cursor, or your own agent and it gains a single tool to fetch any
        URL — and when that URL replies with <C>HTTP 402 Payment Required</C>, the MCP completes the
        x402 payment automatically and returns the content. It is the buyer-side counterpart to the
        Verivyx paywall: one side sells, the other pays.
      </P>

      <H2 id="how">How it works</H2>
      <Ul>
        <Li><strong>Connect once</strong> — add the server URL + your key to any MCP client.</Li>
        <Li><strong>Your agent asks</strong> — it calls a paid API or page through the MCP.</Li>
        <Li><strong>Paid in seconds</strong> — USDC settles on-chain, the agent gets its content, you get a receipt.</Li>
      </Ul>
      <CodeBlock code={TOOL_CALL} lang="text" />

      <H2 id="chains">Supported chains</H2>
      <P>Payments settle in USDC. The MCP auto-selects the chain the resource advertises.</P>
      <Ul>
        <Li><strong>Stellar</strong> — Soroban USDC, ~5s settlement.</Li>
        <Li><strong>Base</strong> — EVM USDC via EIP-3009 (gasless for the payer).</Li>
        <Li><strong>Solana</strong> — SPL USDC, sub-second settlement.</Li>
      </Ul>

      <H2 id="tools">Tools</H2>
      <Ul>
        <Li><C>list_supported_chains</C> — which chains/assets are live, plus the service fee.</Li>
        <Li><C>wallet_info</C> — the active paying wallet and network config per chain.</Li>
        <Li><C>quote_payment</C> — preview the cost (resource price + fee) before paying.</Li>
        <Li><C>pay_for_resource</C> — fetch a URL and pay automatically when required.</Li>
      </Ul>

      <H2 id="connect">Connecting</H2>
      <P>
        The server speaks MCP over Streamable HTTP. Point any MCP client at it with your early-access
        key. Example client configuration:
      </P>
      <CodeBlock code={CONFIG_EXAMPLE} lang="json" />
      <P>
        Then prompt your agent: <em>“Use pay_for_resource to GET https://… and show me the result.”</em>
      </P>

      <H2 id="fees">Fees &amp; custody</H2>
      <Ul>
        <Li><strong>Non-custodial</strong> — funds stay in your wallet via a capped, revocable spend authorization. Verivyx never holds your money.</Li>
        <Li><strong>Flat fee</strong> — a simple <C>$0.001</C> service fee per successful payment, on top of the resource price. Network gas is a fraction of a cent.</Li>
      </Ul>

      <H2 id="next">Get access</H2>
      <P>
        Early access is rolling out now.{' '}
        <A href="https://mcp.verivyx.com">
          Join the waitlist <ArrowRight className="inline h-3.5 w-3.5" />
        </A>
      </P>
    </article>
  );
}
