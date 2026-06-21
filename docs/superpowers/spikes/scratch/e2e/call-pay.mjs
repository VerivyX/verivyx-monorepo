// Minimal Streamable-HTTP MCP client: initialize -> notifications/initialized ->
// tools/call pay_for_resource. Auth via the Hydra JWT in token.txt.
import fs from "node:fs";

const BASE = process.env.MCP_URL || "http://localhost:8088/mcp";
const TOKEN = fs.readFileSync(process.env.TOKEN_FILE || "/work/token.txt", "utf8").trim();
const RESOURCE = process.env.RESOURCE_URL;

let sessionId = null;

function headers(extra = {}) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

// Parse either a JSON body or an SSE stream ("data: {...}") into the first JSON-RPC message.
async function readBody(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) {
        const json = t.slice(5).trim();
        if (json) return JSON.parse(json);
      }
    }
    return null;
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(method, params, isNotification = false) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!isNotification) body.id = Math.floor(Math.random() * 1e6);
  const res = await fetch(BASE, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (isNotification) {
    // 202 Accepted, no body expected.
    return { status: res.status };
  }
  const msg = await readBody(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(msg)}`);
  return msg;
}

(async () => {
  // 1. initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-noncustodial", version: "1.0.0" },
  });
  console.error("initialized; session:", sessionId, "server:", init?.result?.serverInfo?.name);

  // 2. notifications/initialized
  await rpc("notifications/initialized", {}, true);

  // 3. tools/call pay_for_resource
  console.error("calling pay_for_resource:", RESOURCE);
  const result = await rpc("tools/call", {
    name: "pay_for_resource",
    arguments: { url: RESOURCE, method: "GET" },
  });

  // The tool result text payload:
  const content = result?.result?.content?.[0]?.text ?? JSON.stringify(result);
  fs.writeFileSync("/work/pay-result.json", content);
  console.error("isError:", result?.result?.isError === true);
  // Print a trimmed view (no secrets in here).
  try {
    const obj = JSON.parse(content);
    const view = {
      status: obj.status, ok: obj.ok, paymentMade: obj.paymentMade, chain: obj.chain,
      feeError: obj.feeError,
      paymentReceipt: obj.paymentReceipt,
      feeReceipt: obj.feeReceipt,
      error: obj.error, code: obj.code,
    };
    console.error(JSON.stringify(view, null, 2));
  } catch {
    console.error(content.slice(0, 2000));
  }
})().catch((e) => { console.error("CALL FAIL:", e.message); process.exit(1); });
