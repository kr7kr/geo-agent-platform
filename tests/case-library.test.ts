import assert from "node:assert/strict";
import test from "node:test";
import { createCaseRepository } from "../lib/agent/case-library";
import type { ResolveResponse } from "../lib/agent/types";

test("案例库在没有 D1 绑定时仍提供服务端降级存储和反馈统计", async () => {
  const repository = createCaseRepository(null);
  const result: ResolveResponse = {
    runId: `case-test-${Date.now()}`,
    inputText: "北京大学东门附近的咖啡店",
    decision: "COARSE",
    confidence: 0.64,
    summary: "输出候选范围",
    intent: {
      type: "ANCHOR_TARGET",
      target: { name: "咖啡店" },
      anchors: [{ name: "北京大学东门", relation: "NEAR" }],
      adminHints: [], constraints: [], queryPlan: [], needsClarification: false,
    },
    clarification: null,
    toolPlan: [],
    knowledge: { mode: "local-graph-rag", query: "", corpusSize: 0, hits: [], note: "test" },
    entityLinks: [],
    anchor: null,
    candidates: [],
    candidateEvidence: [],
    selectedCandidate: null,
    relations: [],
    spatial: null,
    steps: [],
    provenance: {
      orchestrator: "LangGraph",
      graphVersion: "test",
      retrievalMode: "demo-fallback",
      llmMode: "disabled",
      knowledgeRag: { mode: "local-graph-rag", hitCount: 0 },
      coordinatePipeline: "WGS84 demo index",
      generatedAt: new Date().toISOString(),
    },
  };
  await repository.upsert(result);
  const stored = await repository.get(result.runId);
  assert.equal(stored?.knowledge.note, "test");
  const listed = await repository.list({ search: "北京大学" });
  assert.equal(listed.some((item) => item.id === result.runId), true);
  const updated = await repository.setFeedback(result.runId, "positive");
  assert.equal(updated?.feedback, "positive");
  const metrics = await repository.metrics();
  assert.ok(metrics.feedbackTotal >= 1);
  assert.ok(metrics.feedbackPositive >= 1);
});
