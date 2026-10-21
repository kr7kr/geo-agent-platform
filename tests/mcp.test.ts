import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpJsonRpc } from "../lib/agent/mcp";

test("MCP initialize 和 tools/list 返回可发现的地理工具", async () => {
  const initialized = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized?.result && "protocolVersion" in initialized.result, true);
  assert.equal(initialized?.result && (initialized.result.serverInfo as { name: string }).name, "geolink-spatial-agent");

  const listed = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = listed?.result?.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "geo.resolve_text"));
  assert.ok(tools.some((tool) => tool.name === "geo.retrieve_knowledge"));
  assert.ok(tools.some((tool) => tool.name === "geo.search_around"));
});

test("MCP tools/call 能执行只读距离工具并对未知方法返回协议错误", async () => {
  const called = await handleMcpJsonRpc({
    jsonrpc: "2.0",
    id: "distance",
    method: "tools/call",
    params: { name: "geo.distance", arguments: { from: [116, 39], to: [116.001, 39] } },
  });
  const result = called?.result as { structuredContent: { meters: number; crs: string }; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.crs, "WGS84");
  assert.ok(result.structuredContent.meters > 80);

  const unknown = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 3, method: "not-a-method" });
  assert.equal(unknown?.error?.code, -32601);
});

test("MCP notification 不产生响应体", async () => {
  assert.equal(await handleMcpJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
