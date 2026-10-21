import assert from "node:assert/strict";
import test from "node:test";
import { executeAgentTool, listAgentToolDefinitions } from "../lib/agent/tool-registry";

test("MCP 工具描述是只读且不暴露凭据字段", () => {
  const definitions = listAgentToolDefinitions();
  const names = definitions.map((tool) => tool.name);
  assert.deepEqual(names, ["geo.retrieve_knowledge", "geo.entity_link", "geo.search_text", "geo.resolve_anchor", "geo.search_around", "geo.distance"]);
  assert.ok(definitions.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(JSON.stringify(definitions).includes("AMAP_WEB_SERVICE_KEY"), false);
  assert.equal(JSON.stringify(definitions).includes("apiKey"), false);
});

test("知识图谱 RAG 工具仅返回可验证的实体线索，不返回坐标", async () => {
  const result = await executeAgentTool("geo.retrieve_knowledge", { text: "安理附近的咖啡店" });
  const knowledge = result.knowledge;
  assert.equal(knowledge?.mode, "local-graph-rag");
  assert.equal(knowledge?.hits[0]?.canonicalName, "安徽理工大学");
  assert.equal(JSON.stringify(knowledge).includes("location"), false);
  assert.equal(result.provenance.coordinatePolicy, "no-coordinates");
});

test("距离工具统一返回 WGS84 米制 provenance", async () => {
  const result = await executeAgentTool("geo.distance", { from: [116, 39], to: [116.001, 39] });
  assert.equal(result.crs, "WGS84");
  assert.equal(result.provenance.inputCrs, "WGS84");
  assert.ok(Number(result.meters) > 80 && Number(result.meters) < 100);
});

test("文本工具通过注册表调用高德并保留原始坐标 provenance", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.AMAP_WEB_SERVICE_KEY;
  process.env.AMAP_WEB_SERVICE_KEY = "mock-key";
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      status: "1",
      pois: [{
        id: "mock-poi", name: "安徽理工大学", location: "116.999,32.000",
        cityname: "淮南市", adname: "山南新区", address: "泰丰大街", type: "科教文化服务·高等院校",
      }],
    }));
  }) as typeof fetch;
  try {
    const result = await executeAgentTool("geo.search_text", { query: "安徽理工大学", region: "淮南市" });
    const candidate = result.candidates?.[0];
    assert.equal(result.retrievalMode, "amap-online");
    assert.equal(result.provenance.provider, "amap");
    assert.equal(candidate?.sourceCrs, "GCJ-02");
    assert.equal(candidate?.crs, "WGS84");
    assert.match(requestedUrl, /city_limit=true/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
    else process.env.AMAP_WEB_SERVICE_KEY = previousKey;
  }
});
