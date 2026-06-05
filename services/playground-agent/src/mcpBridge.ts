import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { config } from "./config.js";

const log = pino({ name: "mcpBridge" });

type ToolContent = { type: string; text?: string };
type ToolResult = { content?: ToolContent[]; isError?: boolean };

// Connects to the canonical Verivyx MCP server (mcp.verivyx.com) over Streamable
// HTTP, passing this session's pooled testnet wallet so payments come from it.
// The agent drives it exactly like Claude Desktop would — this is the real MCP.
export class McpSession {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(private readonly walletSecret: string) {}

  async connect(): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(new URL(config.mcpServerUrl), {
      requestInit: {
        headers: {
          "X-Verivyx-MCP-Key": config.mcpApiKey,
          "X-Session-Stellar-Secret": this.walletSecret,
        },
      },
    });
    this.client = new Client({ name: "verivyx-playground", version: "1.0.0" });
    await this.client.connect(this.transport);
    log.info("MCP session connected (remote canonical server)");
  }

  async listToolNames(): Promise<string[]> {
    if (!this.client) throw new Error("MCP not connected");
    const t = await this.client.listTools();
    return t.tools.map((x) => x.name);
  }

  // Call an MCP tool and return its text payload (the tool returns JSON-as-text).
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP not connected");
    const res = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    return text;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;
  }
}
