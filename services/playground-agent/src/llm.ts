import { config } from "./config.js";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: object } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type LlmResponse = {
  choices?: { message?: { content: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  error?: { message?: string };
};

type ChatResult = { content: string | null; toolCalls: ToolCall[] };

// One OpenRouter (OpenAI-compatible) chat completion against a SPECIFIC model.
// Throws "RATE_LIMITED" on HTTP 429 so the caller can retry / fall back.
async function callModel(model: string, messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://playground.verivyx.com",
      "X-Title": "Verivyx x402 Playground",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
  });

  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as LlmResponse;
  if (data.error) throw new Error(data.error.message ?? "OpenRouter error");
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? null, toolCalls: msg?.tool_calls ?? [] };
}

// Chat with tool-calling. Tries the primary model, retries once on a 429, then
// falls back through the configured free models — so a busy/rate-limited free
// model doesn't break the playground turn.
export async function chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult> {
  const models = [config.openrouterModel, ...config.openrouterFallbackModels];
  let lastErr: unknown = new Error("no models configured");
  for (const model of models) {
    try {
      return await callModel(model, messages, tools);
    } catch (e) {
      lastErr = e;
      // On rate limit, give the SAME model one quick retry before falling back.
      if (e instanceof Error && e.message === "RATE_LIMITED") {
        await new Promise((r) => setTimeout(r, 800));
        try {
          return await callModel(model, messages, tools);
        } catch (e2) {
          lastErr = e2;
        }
      }
      // fall through to the next model
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all models failed");
}

export const FETCH_PAID_RESOURCE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "fetch_paid_resource",
    description:
      "Fetch an x402-protected URL and automatically pay with testnet Stellar USDC if the server returns 402. Returns the content plus a payment receipt.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The demo resource URL to fetch." },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (default GET)." },
      },
      required: ["url"],
    },
  },
};

// Probe the same resource WITHOUT paying — demonstrates the paywall blocking
// unpaid access (HTTP 402), i.e. what a bot/scraper sees. Never settles a payment.
export const CHECK_ACCESS_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "check_access_without_paying",
    description:
      "Fetch the demo resource WITHOUT paying, to demonstrate the paywall. Returns HTTP 402 Payment Required and no content — this is exactly what an unpaid bot or scraper receives. Use this when the user wants to see access being blocked, or to compare unpaid vs paid.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The demo resource URL to probe (no payment is made)." },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method (default GET)." },
      },
      required: ["url"],
    },
  },
};
