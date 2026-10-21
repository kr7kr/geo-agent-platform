import { linkSpatialIntent } from "./entity-linker";
import { planWithRules } from "./planner";
import type { EntityLinkStatus, LlmEntityLinkHint } from "./types";

export interface AgentEvalCase {
  id: string;
  input: string;
  role: "target" | "anchor";
  expectedStatus: EntityLinkStatus;
  expectedCanonical?: string;
  llmHints?: LlmEntityLinkHint[];
}

export interface AgentEvalResult {
  id: string;
  input: string;
  passed: boolean;
  actualStatus: EntityLinkStatus;
  actualCanonical?: string;
  expectedStatus: EntityLinkStatus;
  expectedCanonical?: string;
  reason: string;
}

export interface AgentEvalSummary {
  total: number;
  passed: number;
  accuracy: number;
  linkedCases: number;
  ambiguousCases: number;
  results: AgentEvalResult[];
}

/**
 * Evaluate the deterministic planning/entity-linking layer without calling a
 * provider. This makes a small regression set suitable for CI and for a
 * resume/demo command, while online Amap smoke tests remain optional.
 */
export function evaluateEntityLinking(cases: AgentEvalCase[]): AgentEvalSummary {
  const results = cases.map((item): AgentEvalResult => {
    const planned = planWithRules(item.input).intent;
    const linked = linkSpatialIntent(planned, item.llmHints ?? []);
    const match = linked.links.find((link) => link.role === item.role);
    const actualStatus = match?.status ?? "UNLINKED";
    const actualCanonical = match?.selectedCanonicalName ?? match?.candidates[0]?.canonicalName;
    const statusMatch = actualStatus === item.expectedStatus;
    const canonicalMatch = !item.expectedCanonical || actualCanonical === item.expectedCanonical;
    const passed = statusMatch && canonicalMatch;
    return {
      id: item.id,
      input: item.input,
      passed,
      actualStatus,
      actualCanonical,
      expectedStatus: item.expectedStatus,
      expectedCanonical: item.expectedCanonical,
      reason: passed
        ? "实体链接结果符合标注"
        : `实际 ${actualStatus}${actualCanonical ? ` / ${actualCanonical}` : ""}，期望 ${item.expectedStatus}${item.expectedCanonical ? ` / ${item.expectedCanonical}` : ""}`,
    };
  });
  const passed = results.filter((item) => item.passed).length;
  return {
    total: results.length,
    passed,
    accuracy: results.length ? Number((passed / results.length).toFixed(3)) : 0,
    linkedCases: results.filter((item) => item.actualStatus === "LINKED").length,
    ambiguousCases: results.filter((item) => item.actualStatus === "AMBIGUOUS").length,
    results,
  };
}

export const DEFAULT_EVAL_CASES: AgentEvalCase[] = [
  { id: "beihang", input: "北航附近", role: "anchor", expectedStatus: "LINKED", expectedCanonical: "北京航空航天大学" },
  { id: "beike", input: "北科大附近", role: "anchor", expectedStatus: "LINKED", expectedCanonical: "北京科技大学" },
  { id: "beikuang", input: "北矿大附近", role: "anchor", expectedStatus: "LINKED", expectedCanonical: "中国矿业大学（北京）" },
  { id: "dida-ambiguous", input: "地大附近", role: "anchor", expectedStatus: "AMBIGUOUS" },
  { id: "canonical-campus", input: "中国矿业大学（北京）", role: "target", expectedStatus: "LINKED", expectedCanonical: "中国矿业大学（北京）" },
];
