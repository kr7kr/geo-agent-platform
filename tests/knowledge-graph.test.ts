import assert from "node:assert/strict";
import test from "node:test";
import { linkSpatialIntent } from "../lib/agent/entity-linker";
import { resolveGeographicText } from "../lib/agent/graph";
import { retrieveKnowledge } from "../lib/agent/knowledge-graph";
import { planWithRules } from "../lib/agent/planner";

test("地理知识图谱 RAG 为口语简称召回标准实体和行政区关系", () => {
  const knowledge = retrieveKnowledge("我在安理附近找咖啡店");
  const hit = knowledge.hits.find((item) => item.canonicalName === "安徽理工大学");
  assert.ok(hit);
  assert.equal(hit?.entityType, "university");
  assert.equal(hit?.city, "淮南市");
  assert.ok(hit?.relations.some((relation) => relation.includes("位于淮南市田家庵区")));
});

test("图谱 RAG 命中只扩展查询与实体链接，仍不生成坐标", () => {
  const planned = planWithRules("安理附近的咖啡店").intent;
  const knowledge = retrieveKnowledge("安理附近的咖啡店");
  const linked = linkSpatialIntent(planned, [], knowledge.hits);
  const anchor = linked.links.find((item) => item.role === "anchor");
  assert.equal(anchor?.status, "LINKED");
  assert.equal(anchor?.selectedCanonicalName, "安徽理工大学");
  assert.equal(anchor?.candidates[0]?.source, "knowledge_graph");
  assert.ok(linked.intent.adminHints.some((hint) => hint.name === "淮南市" && hint.status === "inferred"));
  assert.equal(JSON.stringify(linked).includes("location"), false);
});

test("无城市的同名高校简称保留图谱歧义而不强行链接", () => {
  const knowledge = retrieveKnowledge("地大附近");
  // The graph intentionally does not give the bare alias “地大” a unique node.
  // It should therefore not fabricate a city-specific graph answer.
  assert.equal(knowledge.hits.some((item) => item.canonicalName === "中国地质大学（北京）"), false);
  assert.equal(knowledge.hits.some((item) => item.canonicalName === "中国地质大学（武汉）"), false);
});

test("条件图在实体链接前执行知识图谱 RAG，并将命中写入结果 provenance", { concurrency: false }, async () => {
  const previousProvider = process.env.AGENT_LLM_PROVIDER;
  const previousAmapKey = process.env.AMAP_WEB_SERVICE_KEY;
  process.env.AGENT_LLM_PROVIDER = "rule";
  delete process.env.AMAP_WEB_SERVICE_KEY;
  try {
    const result = await resolveGeographicText("安理附近的咖啡店");
    const graphIndex = result.steps.findIndex((step) => step.id === "knowledge_rag");
    const linkIndex = result.steps.findIndex((step) => step.id === "entity_linking");
    assert.ok(graphIndex >= 0 && graphIndex < linkIndex);
    assert.equal(result.knowledge.hits[0]?.canonicalName, "安徽理工大学");
    assert.equal(result.provenance.knowledgeRag.hitCount, result.knowledge.hits.length);
    assert.equal(result.entityLinks.find((link) => link.role === "anchor")?.selectedCanonicalName, "安徽理工大学");
  } finally {
    process.env.AGENT_LLM_PROVIDER = previousProvider;
    if (previousAmapKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
    else process.env.AMAP_WEB_SERVICE_KEY = previousAmapKey;
  }
});
