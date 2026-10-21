import { resolveGeographicText } from "./graph";
import { executeAgentTool, listAgentToolDefinitions } from "./tool-registry";

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: "geolink-spatial-agent",
  version: "0.9.0",
};

const RESOLVE_TEXT_TOOL = {
  name: "geo.resolve_text",
  title: "中文地理文本空间化",
  description: "运行证据驱动的中文空间检索 Agent，返回结构化意图、工具轨迹、候选证据和 RESOLVED/COARSE/ABSTAIN/NEED_CLARIFICATION 决策。LLM 只生成意图，坐标和最终决策由检索与证据节点产生。",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 2_000 } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

function requestId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textContent(value: unknown) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function toolCallResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: textContent(value), structuredContent: value, isError };
}

/** Handle one MCP JSON-RPC request. HTTP/session concerns stay in the route. */
export async function handleMcpJsonRpc(input: unknown): Promise<McpResponse | null> {
  const payload = object(input) as McpRequest;
  const id = requestId(payload.id);
  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return rpcError(id, -32600, "Invalid Request");
  }
  const method = payload.method;
  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "通过 geo.resolve_text 调用完整空间 Agent，或组合 geo.retrieve_knowledge、geo.entity_link、geo.resolve_anchor、geo.search_text、geo.search_around 和 geo.distance。图谱 RAG 只提供待验证线索，不返回坐标或最终决策。",
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: [RESOLVE_TEXT_TOOL, ...listAgentToolDefinitions()] },
    };
  }
  if (method !== "tools/call") return rpcError(id, -32601, `Method not found: ${method}`);

  const params = object(payload.params);
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) return rpcError(id, -32602, "tools/call requires params.name");
  const args = params.arguments ?? {};
  try {
    let value: unknown;
    if (name === "geo.resolve_text") {
      const text = object(args).text;
      if (typeof text !== "string" || !text.trim() || text.length > 2_000) {
        return rpcError(id, -32602, "geo.resolve_text requires 1-2000 characters in arguments.text");
      }
      value = await resolveGeographicText(text);
    } else {
      value = await executeAgentTool(name, args);
    }
    return { jsonrpc: "2.0", id, result: toolCallResult(value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { jsonrpc: "2.0", id, result: toolCallResult({ error: message }, true) };
  }
}
