import { handleMcpJsonRpc } from "@/lib/agent/mcp";
import { listAgentToolDefinitions } from "@/lib/agent/tool-registry";

const MAX_BODY_BYTES = 64_000;

export async function GET() {
  return Response.json({
    name: "geolink-spatial-agent",
    version: "0.8.0",
    protocol: "MCP JSON-RPC",
    endpoint: "/api/mcp",
    methods: ["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"],
    tools: ["geo.resolve_text", ...listAgentToolDefinitions().map((tool) => tool.name)],
  });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "MCP 请求体过大。" }, { status: 413 });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const response = await handleMcpJsonRpc(payload);
  // Notifications intentionally have no JSON-RPC response body.
  if (!response) return new Response(null, { status: 204 });
  return Response.json(response);
}

