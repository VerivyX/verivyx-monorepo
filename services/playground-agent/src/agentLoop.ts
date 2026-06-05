import { chat, FETCH_PAID_RESOURCE_TOOL, CHECK_ACCESS_TOOL, type ChatMessage } from "./llm.js";
import { assertAllowedUrl } from "./sandbox.js";
import type { McpSession } from "./mcpBridge.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; url: string; method: string; paid: boolean }
  | { type: "payment"; paymentMade: boolean; status?: number; transaction?: string; amount?: string; error?: string }
  | { type: "access_check"; status?: number; blocked: boolean; error?: string }
  | { type: "final" }
  | { type: "error"; message: string };

const MAX_ITERS = 4;

export function systemPrompt(demoUrl: string): string {
  return [
    "You are the Verivyx x402 payment agent inside a sandboxed Stellar TESTNET playground.",
    "Your ONLY purpose is to demonstrate Verivyx: the x402 payment protocol, paying for content with",
    "testnet USDC on Stellar, and how this playground works.",
    "You control a Stellar wallet that holds a little test USDC.",
    "You have TWO abilities, both only for this exact demo URL:",
    demoUrl,
    "1) fetch_paid_resource(url): pay with testnet USDC over x402 and unlock the content. Use this when the",
    "   user wants the premium/demo content. After paying, briefly summarize the unlocked content and state",
    "   that payment settled on Stellar testnet (mention the tx if available).",
    "2) check_access_without_paying(url): fetch the SAME resource WITHOUT paying. It returns HTTP 402 and no",
    "   content — exactly what an unpaid bot or scraper sees. Use this when the user wants to see access being",
    "   blocked, or wants to test/try without paying.",
    "If the user asks to compare or see both, first call check_access_without_paying to show the 402 block,",
    "then call fetch_paid_resource to pay and unlock — and contrast the two outcomes.",
    "Only ever use that demo URL — never any other URL.",
    "STRICT TOPIC LIMIT: only discuss Verivyx, the x402 protocol, Stellar/USDC payments, the demo resource,",
    "and how this playground works. If the user asks about anything unrelated — general knowledge, coding",
    "help, other products, news, personal questions, math, etc. — do NOT answer it. Politely decline in one",
    "sentence and steer them back to trying the Verivyx payment demo. Never call any tool for off-topic requests.",
    "Be concise and friendly.",
  ].join("\n");
}

type ToolResultJson = {
  status?: number;
  paymentMade?: boolean;
  paymentReceipt?: { transaction?: string; amount?: string } | null;
  response?: unknown;
};

// Runs one user turn: drives the LLM ↔ MCP loop, emitting events for the UI.
// `messages` (including the system prompt) is mutated in place to persist history.
export async function runAgentTurn(
  mcp: McpSession,
  messages: ChatMessage[],
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      onEvent({ type: "status", text: "thinking" });
      const { content, toolCalls } = await chat(messages, [FETCH_PAID_RESOURCE_TOOL, CHECK_ACCESS_TOOL]);

      if (!toolCalls.length) {
        const text = content ?? "(no response)";
        messages.push({ role: "assistant", content: text });
        onEvent({ type: "assistant", content: text });
        onEvent({ type: "final" });
        return;
      }

      messages.push({ role: "assistant", content: content ?? "", tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const unpaid = tc.function.name === "check_access_without_paying";
        let toolResult: string;
        try {
          const args = JSON.parse(tc.function.arguments || "{}") as { url?: string; method?: string };
          const url = String(args.url ?? "");
          const method = args.method === "POST" ? "POST" : "GET";
          onEvent({ type: "tool_call", url, method, paid: !unpaid });
          assertAllowedUrl(url);

          if (unpaid) {
            // Plain fetch, no payment — demonstrate the 402 block a bot/scraper hits.
            onEvent({ type: "status", text: "checking" });
            const r = await fetch(url, { method });
            const body = await r.text();
            const blocked = r.status === 402;
            onEvent({ type: "access_check", status: r.status, blocked });
            toolResult = JSON.stringify({
              status: r.status,
              blocked,
              paymentMade: false,
              note: blocked
                ? "Access denied — HTTP 402 Payment Required. The resource is paywalled; no content was returned because no payment was made. This is what an unpaid bot or scraper receives."
                : "Unexpected: the resource did not return 402 without payment.",
              response: body.slice(0, 500),
            });
          } else {
            onEvent({ type: "status", text: "paying" });
            // Canonical MCP server tool (was fetch_paid_resource in the old vendored server).
            toolResult = await mcp.callTool("pay_for_resource", { url, method });
            const parsed = JSON.parse(toolResult) as ToolResultJson;
            onEvent({
              type: "payment",
              paymentMade: Boolean(parsed.paymentMade),
              status: parsed.status,
              transaction: parsed.paymentReceipt?.transaction,
              amount: parsed.paymentReceipt?.amount,
            });
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : "tool failed";
          toolResult = JSON.stringify({ error: message });
          if (unpaid) onEvent({ type: "access_check", blocked: false, error: message });
          else onEvent({ type: "payment", paymentMade: false, error: message });
        }
        messages.push({ role: "tool", content: toolResult, tool_call_id: tc.id });
      }
    }
    onEvent({ type: "assistant", content: "I've reached the step limit for this turn." });
    onEvent({ type: "final" });
  } catch (e) {
    const message = e instanceof Error && e.message === "RATE_LIMITED"
      ? "The free model is busy right now (rate limit). Please try again in a moment."
      : e instanceof Error
        ? e.message
        : "agent error";
    onEvent({ type: "error", message });
  }
}
