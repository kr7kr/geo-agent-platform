import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EVAL_CASES, evaluateEntityLinking } from "../lib/agent/evaluation";

test("确定性实体链接回归集保持可解释的通过率", () => {
  const summary = evaluateEntityLinking(DEFAULT_EVAL_CASES);
  assert.equal(summary.total, 5);
  assert.equal(summary.passed, summary.total);
  assert.equal(summary.accuracy, 1);
  assert.equal(summary.ambiguousCases, 1);
});
