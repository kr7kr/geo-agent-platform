import { DEFAULT_EVAL_CASES, evaluateEntityLinking } from "../lib/agent/evaluation";

const summary = evaluateEntityLinking(DEFAULT_EVAL_CASES);
console.log(JSON.stringify({
  suite: "deterministic-entity-linking",
  ...summary,
}, null, 2));

if (summary.passed !== summary.total) process.exitCode = 1;
