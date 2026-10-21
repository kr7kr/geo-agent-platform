import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import { enrichIntentWithConfiguredLlm, type LlmMode } from "./llm";
import {
  intentSummary,
  mergeIntent,
  normalizeText,
  planWithRules,
  relationsForIntent,
} from "./planner";
import { isExactVerified, rankCandidates } from "./ranker";
import { buildAdaptiveS2 } from "./s2";
import { buildToolPlan, executeAgentTool } from "./tool-registry";
import type {
  AgentStep, AgentToolPlan, Candidate, CandidateEvidence, ClarificationRequest,
  Decision, RelationEvidence, EntityLinkResult, LlmEntityLinkHint, ResolveResponse,
  KnowledgeRetrieval, S2Representation, SpatialAnchor, SpatialIntent,
} from "./types";

const GRAPH_VERSION = "geolink-agent-0.9.0";

function emptyKnowledge(query = ""): KnowledgeRetrieval {
  return {
    mode: "local-graph-rag",
    query,
    corpusSize: 0,
    hits: [],
    note: "知识图谱 RAG 未返回可用线索。",
  };
}

const AgentState = Annotation.Root({
  text: Annotation<string>(),
  intent: Annotation<SpatialIntent>({
    default: () => ({ type: "AMBIGUOUS", target: null, anchors: [], adminHints: [], constraints: [], queryPlan: [], needsClarification: true }),
    reducer: (_, right) => right,
  }),
  entityLinks: Annotation<EntityLinkResult[]>({ default: () => [], reducer: (_, right) => right }),
  llmEntityLinkHints: Annotation<LlmEntityLinkHint[]>({ default: () => [], reducer: (_, right) => right }),
  knowledge: Annotation<KnowledgeRetrieval>({ default: () => emptyKnowledge(), reducer: (_, right) => right }),
  toolPlan: Annotation<AgentToolPlan[]>({ default: () => [], reducer: (_, right) => right }),
  relations: Annotation<RelationEvidence[]>({ default: () => [], reducer: (_, right) => right }),
  anchor: Annotation<Candidate | null>({ default: () => null, reducer: (_, right) => right }),
  candidates: Annotation<Candidate[]>({ default: () => [], reducer: (_, right) => right }),
  candidateEvidence: Annotation<CandidateEvidence[]>({ default: () => [], reducer: (_, right) => right }),
  selectedCandidate: Annotation<Candidate | null>({ default: () => null, reducer: (_, right) => right }),
  decision: Annotation<Decision>({ default: () => "ABSTAIN", reducer: (_, right) => right }),
  confidence: Annotation<number>({ default: () => 0, reducer: (_, right) => right }),
  summary: Annotation<string>({ default: () => "", reducer: (_, right) => right }),
  clarification: Annotation<ClarificationRequest | null>({ default: () => null, reducer: (_, right) => right }),
  spatial: Annotation<S2Representation | null>({ default: () => null, reducer: (_, right) => right }),
  retrievalMode: Annotation<"amap-online" | "demo-fallback">({ default: () => "demo-fallback", reducer: (_, right) => right }),
  llmMode: Annotation<LlmMode>({ default: () => "disabled", reducer: (_, right) => right }),
  retryCount: Annotation<number>({ default: () => 0, reducer: (_, right) => right }),
  reflectNeeded: Annotation<boolean>({ default: () => false, reducer: (_, right) => right }),
  steps: Annotation<AgentStep[]>({ default: () => [], reducer: (left, right) => left.concat(right) }),
});

type State = typeof AgentState.State;

function elapsed(started: number) { return Math.max(1, Date.now() - started); }

function step(id: string, label: string, tool: string, durationMs: number, summary: string, details?: string[], status: AgentStep["status"] = "complete") {
  return { id, label, tool, durationMs, summary, ...(details?.length ? { details } : {}), status };
}

function regionHint(intent: SpatialIntent) {
  // Amap accepts city and district/adcode names as a strict text-search region.
  // Prefer the explicit district when present; it is the narrower evidence.
  return intent.adminHints.find((hint) => hint.level === "district")?.name ??
    intent.adminHints.find((hint) => hint.level === "city")?.name ?? null;
}

function entityTypeMatches(candidate: Candidate, entityType: SpatialAnchor["entityType"]) {
  if (!entityType || entityType === "unknown") return true;
  if (entityType === "university") return /大学|学院|高等院校|学校|科教/.test(`${candidate.name}${candidate.category}`);
  if (entityType === "hospital") return /医院|医疗/.test(`${candidate.name}${candidate.category}`);
  if (entityType === "station") return /站|交通/.test(`${candidate.name}${candidate.category}`);
  return true;
}

function resolveAnchorCandidate(candidates: Candidate[], anchor: SpatialAnchor) {
  const query = normalizeText(anchor.name);
  const eligible = anchor.entityType
    ? candidates.filter((candidate) => entityTypeMatches(candidate, anchor.entityType))
    : candidates;
  return eligible
    .map((candidate) => ({
      candidate,
      exact: normalizeText(candidate.name).includes(query) || query.includes(normalizeText(candidate.name)),
      typeMatch: entityTypeMatches(candidate, anchor.entityType),
    }))
    .sort((left, right) => Number(right.exact) - Number(left.exact) || Number(right.typeMatch) - Number(left.typeMatch) || left.candidate.sourceRank - right.candidate.sourceRank)[0]?.candidate ?? null;
}

function directionalOffset(candidate: Candidate, intent: SpatialIntent) {
  const distance = intent.constraints.find((item) => item.kind === "distance")?.distanceMeters;
  const direction = intent.constraints.find((item) => item.kind === "direction")?.direction;
  if (!distance || !direction || distance > 50_000) return candidate;
  const [lng, lat] = candidate.location;
  const latDelta = distance / 111_320;
  const lngDelta = distance / (111_320 * Math.cos((lat * Math.PI) / 180));
  let dx = 0;
  let dy = 0;
  if (/东/.test(direction)) dx = lngDelta;
  if (/西/.test(direction)) dx = -lngDelta;
  if (/北/.test(direction)) dy = latDelta;
  if (/南/.test(direction)) dy = -latDelta;
  if (/东北|西北|东南|西南/.test(direction)) { dx /= Math.sqrt(2); dy /= Math.sqrt(2); }
  return {
    ...candidate,
    id: `${candidate.id}-inferred`,
    name: `${candidate.name}${direction}约${distance}米`,
    location: [Number((lng + dx).toFixed(6)), Number((lat + dy).toFixed(6))] as [number, number],
    geometryOrigin: "relation-inference" as const,
    derivedFromId: candidate.id,
    uncertaintyRadiusMeters: Math.max(80, Math.round(distance * 0.25)),
    coordinateAccuracyMeters: Math.max(candidate.coordinateAccuracyMeters ?? 0, Math.max(80, Math.round(distance * 0.25))),
    evidence: [...candidate.evidence, `依据“${direction}约${distance}米”推断目标中心`],
  };
}

function nearbyAnchorArea(candidate: Candidate) {
  const uncertaintyRadiusMeters = 700;
  return {
    ...candidate,
    id: `${candidate.id}-nearby-area`,
    name: `${candidate.name}附近`,
    geometryOrigin: "relation-inference" as const,
    derivedFromId: candidate.id,
    uncertaintyRadiusMeters,
    coordinateAccuracyMeters: Math.max(candidate.coordinateAccuracyMeters ?? 0, uncertaintyRadiusMeters),
    evidence: [...candidate.evidence, "已验证简称对应的参照实体；“附近”未给出精确方向或距离，使用保守范围表达"],
  };
}

async function semanticPlanNode(state: State) {
  const started = Date.now();
  const rule = planWithRules(state.text);
  const enriched = await enrichIntentWithConfiguredLlm(state.text, rule.intent);
  const intent = mergeIntent(rule.intent, enriched.intent);
  const relations = relationsForIntent(intent);
  const summary = enriched.mode === "cloud" || enriched.mode === "local"
    ? `规则与${enriched.mode === "cloud" ? "云端" : "本地"} LLM 已合并为可执行检索计划`
    : enriched.mode === "fallback"
      ? `LLM 不可用（${enriched.error ?? "未知错误"}），采用确定性检索计划`
      : "未配置 LLM，采用确定性检索计划";
  return {
    intent, relations, llmEntityLinkHints: enriched.entityLinkHints, llmMode: enriched.mode,
    steps: [step("semantic_plan", "语义规划", "agent.semantic_plan", elapsed(started), summary, intentSummary(intent), enriched.mode === "fallback" ? "warning" : "complete")],
  };
}

async function knowledgeRagNode(state: State) {
  const started = Date.now();
  try {
    const toolResult = await executeAgentTool("geo.retrieve_knowledge", { text: state.text });
    const knowledge = toolResult.knowledge ?? emptyKnowledge(state.text);
    const details = knowledge.hits.flatMap((hit) => [
      `命中：${hit.canonicalName} · ${(hit.score * 100).toFixed(0)} 分 · ${hit.matchedTerms.join("、")}`,
      ...hit.relations.slice(0, 1),
    ]);
    return {
      knowledge,
      steps: [step(
        "knowledge_rag",
        "地理知识图谱 RAG",
        "geo.retrieve_knowledge",
        elapsed(started),
        knowledge.hits.length
          ? `从 ${knowledge.corpusSize} 个图谱实体中召回 ${knowledge.hits.length} 条可验证线索`
          : "未召回足够强的图谱线索，保留原始文本进入后续检索",
        [...details, knowledge.note],
        knowledge.hits.length ? "complete" : "skipped",
      )],
    };
  } catch {
    const knowledge = emptyKnowledge(state.text);
    return {
      knowledge,
      steps: [step("knowledge_rag", "地理知识图谱 RAG", "geo.retrieve_knowledge", elapsed(started), "图谱检索工具不可用，跳过并继续后续流程", [knowledge.note], "warning")],
    };
  }
}

async function entityLinkingNode(state: State) {
  const started = Date.now();
  const linked = await executeAgentTool("geo.entity_link", {
    intent: state.intent,
    hints: state.llmEntityLinkHints,
    knowledge: state.knowledge.hits,
  });
  const linkedIntent = linked.intent ?? state.intent;
  const links = linked.links ?? [];
  const linkedCount = links.filter((link) => link.status === "LINKED").length;
  const ambiguous = links.filter((link) => link.status === "AMBIGUOUS");
  const details = links.flatMap((link) => {
    if (link.status === "LINKED") return [`${link.role === "anchor" ? "锚点" : "目标"}：${link.mention} → ${link.selectedCanonicalName}（${link.candidates[0]?.source ?? "curated"}）`];
    if (link.status === "AMBIGUOUS") return [`${link.role === "anchor" ? "锚点" : "目标"}：${link.evidence[0]}`];
    return [`${link.role === "anchor" ? "锚点" : "目标"}：${link.mention} 未命中别名库，保留原文`];
  });
  const summary = ambiguous.length
    ? `发现 ${ambiguous.length} 个简称歧义，暂停检索并请求更多地域或全称线索`
    : linkedCount
      ? `已将 ${linkedCount} 个口语化提及链接为可验证标准实体`
      : "未发现可链接简称，沿用原始实体文本";
  return {
    intent: linkedIntent, entityLinks: links,
    steps: [step("entity_linking", "实体链接与简称消歧", "geo.entity_link", elapsed(started), summary, details, ambiguous.length ? "warning" : "complete")],
  };
}

async function toolRouterNode(state: State) {
  const started = Date.now();
  const proposedPlan = buildToolPlan(state.intent);
  // Do not present provider calls as if they will execute when the conditional
  // graph is about to ask for clarification or abstain. The trace should be a
  // faithful plan of the branch that is actually reachable.
  const toolPlan = routeFromIntent(state) === "decision"
    ? proposedPlan.filter((item) => item.stage === "link")
    : proposedPlan;
  const executable = toolPlan.filter((item) => item.stage === "anchor" || item.stage === "target" || item.stage === "around");
  return {
    toolPlan,
    steps: [step(
      "tool_router",
      "工具规划",
      "agent.tool_router",
      elapsed(started),
      executable.length
        ? `根据结构化意图选择 ${executable.map((item) => item.label).join("、")}`
        : "没有安全可执行的外部检索工具，进入澄清/拒答策略",
      toolPlan.map((item) => `${item.label}：${item.reason}`),
      executable.length ? "complete" : "warning",
    )],
  };
}

async function intentRouterNode(state: State) {
  const started = Date.now();
  const branch = routeFromIntent(state);
  return { steps: [step("intent_router", "条件路由", "agent.intent_router", elapsed(started), `选择分支：${branch}`, [`目标：${state.intent.target?.name ?? "无"}`, `锚点：${state.intent.anchors[0]?.name ?? "无"}`]) ] };
}

function routeFromIntent(state: State) {
  if (state.entityLinks.some((link) => link.status === "AMBIGUOUS")) return "decision";
  if (state.intent.anchors.length) {
    const hasDirectionalRange = state.intent.constraints.some((constraint) => constraint.kind === "direction") &&
      state.intent.constraints.some((constraint) => constraint.kind === "distance");
    const hasLinkedAnchor = state.entityLinks.some((link) => link.role === "anchor" && link.status === "LINKED");
    if (state.intent.target || hasDirectionalRange || hasLinkedAnchor) return "resolve_anchor";
  }
  return state.intent.target ? "direct_search" : "decision";
}

async function resolveAnchorNode(state: State) {
  const started = Date.now();
  const anchorIntent = state.intent.anchors[0];
  if (!anchorIntent) return { steps: [step("resolve_anchor", "参照地标验证", "geo.resolve_anchor", elapsed(started), "没有可执行的参照地标", undefined, "warning")] };
  try {
    const region = regionHint(state.intent);
    const toolResult = await executeAgentTool("geo.resolve_anchor", { query: anchorIntent.name, region });
    const candidates = toolResult.candidates ?? [];
    const anchor = resolveAnchorCandidate(candidates, anchorIntent);
    return {
      anchor, retrievalMode: toolResult.retrievalMode ?? "demo-fallback",
      steps: [step("resolve_anchor", "参照地标验证", "geo.resolve_anchor", elapsed(started), anchor ? `已验证锚点“${anchor.name}”` : `无法验证锚点“${anchorIntent.name}”`, [`查询：${anchorIntent.name}`, `区域：${region ?? "未限定"}`, `检索模式：${toolResult.retrievalMode ?? "unknown"}`, ...(anchor ? [`地址：${anchor.address}`] : [])], anchor ? "complete" : "warning")],
    };
  } catch {
    return { steps: [step("resolve_anchor", "参照地标验证", "geo.resolve_anchor", elapsed(started), "锚点工具检索失败", undefined, "warning")] };
  }
}

function routeAfterAnchor(state: State) { return state.anchor && state.intent.target ? "around_search" : "decision"; }

async function aroundSearchNode(state: State) {
  const started = Date.now();
  const plan = state.intent.queryPlan.find((item) => item.stage === "around");
  if (!state.anchor || !state.intent.target || !plan) {
    return { steps: [step("around_search", "周边目标检索", "geo.search_around", elapsed(started), "缺少已验证锚点或目标", undefined, "warning")] };
  }
  try {
    const toolResult = await executeAgentTool("geo.search_around", {
      query: state.intent.target.name,
      anchor: state.anchor,
      radiusMeters: plan.radiusMeters,
      mentions: [state.intent.target.originalMention ?? state.intent.target.name],
    });
    const candidates = toolResult.candidates ?? [];
    return {
      candidates, retrievalMode: toolResult.retrievalMode ?? "demo-fallback",
      steps: [step("around_search", "周边目标检索", "geo.search_around", elapsed(started), candidates.length ? `围绕“${state.anchor.name}”召回 ${candidates.length} 个目标候选` : "参照范围内没有可验证目标", [`关键词：${state.intent.target.name}`, `半径：${plan.radiusMeters ?? 3_000} 米`, `锚点：${state.anchor.name}`, `检索模式：${toolResult.retrievalMode ?? "unknown"}`], candidates.length ? "complete" : "warning")],
    };
  } catch {
    return { steps: [step("around_search", "周边目标检索", "geo.search_around", elapsed(started), "周边检索工具失败", undefined, "warning")] };
  }
}

async function directSearchNode(state: State) {
  const started = Date.now();
  const target = state.intent.target;
  if (!target) return { steps: [step("direct_search", "目标实体检索", "geo.search_text", elapsed(started), "没有目标实体", undefined, "skipped")] };
  const refinement = target.entityType === "university"
    ? "大学"
    : target.entityType === "hospital"
      ? "医院"
      : target.category ?? "";
  const query = state.retryCount > 0
    ? `${target.name} ${refinement}`.trim()
    : target.name;
  try {
    const region = regionHint(state.intent);
    const toolResult = await executeAgentTool("geo.search_text", { query, region, mentions: [target.originalMention ?? target.name] });
    const candidates = toolResult.candidates ?? [];
    return { candidates, retrievalMode: toolResult.retrievalMode ?? "demo-fallback", steps: [step("direct_search", "目标实体检索", "geo.search_text", elapsed(started), candidates.length ? `召回 ${candidates.length} 个候选` : "未召回候选", [`关键词：${query}`, `区域：${region ?? "未限定"}`, `检索模式：${toolResult.retrievalMode ?? "unknown"}`], candidates.length ? "complete" : "warning")] };
  } catch {
    return { steps: [step("direct_search", "目标实体检索", "geo.search_text", elapsed(started), "文本检索工具失败", undefined, "warning")] };
  }
}

function routeAfterDirect(state: State) {
  return state.candidates.length || state.retryCount >= 1 ? "rank_candidates" : "query_rewrite";
}

async function queryRewriteNode(state: State) {
  const started = Date.now();
  const target = state.intent.target;
  return {
    retryCount: state.retryCount + 1,
    steps: [step("query_rewrite", "查询改写", "agent.query_rewrite", elapsed(started), target ? `首次检索无结果，改用品牌词“${target.brand ?? target.name}”重试一次` : "没有可改写的目标", target ? [`原始目标：${target.name}`, `改写查询：${target.brand ?? target.name}`] : [], target ? "warning" : "skipped")],
  };
}

async function rankNode(state: State) {
  const started = Date.now();
  const ranked = rankCandidates(state.candidates, state.intent);
  return {
    candidates: ranked.candidates, candidateEvidence: ranked.evidence,
    steps: [step("rank_candidates", "证据融合排序", "agent.rank_candidates", elapsed(started), ranked.candidates.length ? `保留 ${ranked.candidates.length} 个候选，淘汰 ${ranked.evidence.filter((item) => item.verdict === "rejected").length} 个冲突候选` : "没有通过硬约束的候选", ranked.candidates.slice(0, 3).map((candidate) => `${candidate.name} · ${(candidate.score * 100).toFixed(0)} 分`), ranked.candidates.length ? "complete" : "warning")],
  };
}

async function verifyNode(state: State) {
  const started = Date.now();
  const top = state.candidates[0];
  const second = state.candidates[1];
  const evidence = top ? state.candidateEvidence.find((item) => item.candidateId === top.id)?.reasons ?? [] : [];
  const margin = top && second ? top.score - second.score : top?.score ?? 0;
  const reflectNeeded = Boolean(
    state.intent.type === "DIRECT_POI" &&
    top &&
    state.retryCount < 1 &&
    (top.score < 0.62 || margin < 0.08),
  );
  return {
    reflectNeeded,
    steps: [step(
      "verify_evidence",
      "证据验证",
      "agent.verify_evidence",
      elapsed(started),
      top
        ? `首选候选“${top.name}”已通过硬约束检查；候选间隔 ${margin.toFixed(2)}`
        : "没有可验证候选",
      [...evidence, ...(reflectNeeded ? ["证据间隔不足，触发一次受控反思重检"] : [])],
      top ? "complete" : "warning",
    )],
  };
}

function routeAfterVerify(state: State) {
  return state.reflectNeeded ? "reflect" : "decision";
}

async function reflectEvidenceNode(state: State) {
  const started = Date.now();
  const target = state.intent.target;
  return {
    retryCount: state.retryCount + 1,
    reflectNeeded: false,
    steps: [step(
      "reflect_evidence",
      "证据反思重检",
      "agent.reflect_evidence",
      elapsed(started),
      "候选证据不足以稳定决策，基于实体类型和目标名称改写查询并仅重试一次",
      target ? [`原查询：${target.name}`, `反思提示：${target.entityType ?? "unknown"} / ${target.category ?? "未提供"}`] : undefined,
      "warning",
    )],
  };
}

async function decisionNode(state: State) {
  const started = Date.now();
  const directionalOnly = !state.intent.target && Boolean(state.anchor) &&
    state.intent.constraints.some((constraint) => constraint.kind === "direction") &&
    state.intent.constraints.some((constraint) => constraint.kind === "distance");
  const linkedAnchorOnly = !state.intent.target && Boolean(state.anchor) &&
    state.entityLinks.some((link) => link.role === "anchor" && link.status === "LINKED");
  const relationOnly = directionalOnly || linkedAnchorOnly;
  const top = state.candidates[0] ?? (relationOnly ? state.anchor : null);
  const second = state.candidates[1] ?? null;
  const margin = top ? (second ? top.score - second.score : top.score) : 0;
  let decision: Decision = "ABSTAIN";
  const ambiguousLink = state.entityLinks.find((link) => link.status === "AMBIGUOUS");
  if (ambiguousLink) decision = "NEED_CLARIFICATION";
  else if (relationOnly) decision = "COARSE";
  else if (top && state.intent.type === "DIRECT_POI" && isExactVerified(top, state.intent) && margin >= 0.1) decision = "RESOLVED";
  else if (top && top.score >= 0.5) decision = "COARSE";
  const selectedCandidate = top && decision !== "ABSTAIN" && decision !== "NEED_CLARIFICATION"
    ? directionalOnly ? directionalOffset(top, state.intent) : linkedAnchorOnly ? nearbyAnchorArea(top) : top
    : null;
  const confidence = decision === "ABSTAIN" ? 0.08 : decision === "NEED_CLARIFICATION" ? 0.2 : directionalOnly ? 0.72 : linkedAnchorOnly ? 0.66 : top?.scores?.decisionConfidence ?? top?.score ?? 0;
  const summary = decision === "RESOLVED"
    ? `已验证“${top?.name}”为唯一精确候选。`
    : directionalOnly
      ? "已验证参照地标，并依据方向与距离约束输出推断空间范围。"
      : linkedAnchorOnly
        ? "已验证口语简称对应的参照实体；“附近”缺少精确方向或距离，输出保守空间范围。"
      : decision === "NEED_CLARIFICATION"
      ? `简称“${ambiguousLink?.mention ?? "该实体"}”存在多个合理解释，请选择一个标准实体或补充城市/校区。`
      : decision === "COARSE"
      ? "目标或空间关系仍存在不确定性，输出由证据支持的空间范围。"
      : state.entityLinks.some((link) => link.status === "AMBIGUOUS")
        ? `简称“${state.entityLinks.find((link) => link.status === "AMBIGUOUS")?.mention}”存在多个合理实体，请补充城市、校区或全称。`
        : state.intent.needsClarification
        ? "未形成可验证的目标实体，请补充城市、地标或门店限定词。"
        : "现有候选不足以形成可靠空间判断，已主动拒答。";
  const clarification: ClarificationRequest | null = ambiguousLink
    ? {
        question: "你指的是哪个标准实体？",
        options: ambiguousLink.candidates.map((candidate) => candidate.canonicalName),
        reason: ambiguousLink.evidence[0] ?? "简称存在多个候选实体",
      }
    : null;
  return {
    decision, selectedCandidate, confidence, summary, clarification,
      steps: [step("decision", "决策与拒答", "agent.decision", elapsed(started), `${decision} · 决策分数 ${(confidence * 100).toFixed(0)}% · 候选间隔 ${margin.toFixed(2)}`, top?.evidence.slice(-4), decision === "ABSTAIN" || decision === "NEED_CLARIFICATION" ? "warning" : "complete")],
  };
}

async function s2Node(state: State) {
  const started = Date.now();
  const spatial = buildAdaptiveS2(state.selectedCandidate, state.decision, state.confidence, state.relations.filter((relation) => relation.predicate !== "UNKNOWN").length);
  return { spatial, steps: [step("s2", "空间化表达", "agent.adaptive_s2", elapsed(started), spatial ? `自适应选择 S2 Level ${spatial.level}，生成 ${spatial.cellCount} 个单元` : "拒答状态不生成空间网格", spatial ? [spatial.coverageNote ?? ""] : [], spatial ? "complete" : "skipped")] };
}

const graph = new StateGraph(AgentState)
  .addNode("semantic_plan", semanticPlanNode)
  .addNode("knowledge_rag", knowledgeRagNode)
  .addNode("entity_linking", entityLinkingNode)
  .addNode("tool_router", toolRouterNode)
  .addNode("intent_router", intentRouterNode)
  .addNode("resolve_anchor", resolveAnchorNode)
  .addNode("around_search", aroundSearchNode)
  .addNode("direct_search", directSearchNode)
  .addNode("query_rewrite", queryRewriteNode)
  .addNode("rank_candidates", rankNode)
  .addNode("verify_evidence", verifyNode)
  .addNode("reflect_evidence", reflectEvidenceNode)
  .addNode("make_decision", decisionNode)
  .addNode("build_s2", s2Node)
  .addEdge(START, "semantic_plan")
  .addEdge("semantic_plan", "knowledge_rag")
  .addEdge("knowledge_rag", "entity_linking")
  .addEdge("entity_linking", "tool_router")
  .addEdge("tool_router", "intent_router")
  .addConditionalEdges("intent_router", routeFromIntent, { resolve_anchor: "resolve_anchor", direct_search: "direct_search", decision: "make_decision" })
  .addConditionalEdges("resolve_anchor", routeAfterAnchor, { around_search: "around_search", decision: "make_decision" })
  .addEdge("around_search", "rank_candidates")
  .addConditionalEdges("direct_search", routeAfterDirect, { rank_candidates: "rank_candidates", query_rewrite: "query_rewrite" })
  .addEdge("query_rewrite", "direct_search")
  .addEdge("rank_candidates", "verify_evidence")
  .addConditionalEdges("verify_evidence", routeAfterVerify, { reflect: "reflect_evidence", decision: "make_decision" })
  .addEdge("reflect_evidence", "direct_search")
  .addEdge("make_decision", "build_s2")
  .addEdge("build_s2", END)
  .compile();

export async function resolveGeographicText(text: string): Promise<ResolveResponse> {
  const cleaned = text.trim();
  if (!cleaned) throw new Error("请输入需要空间化的中文地理文本。");
  const state = await graph.invoke({ text: cleaned });
  return {
    runId: crypto.randomUUID(), inputText: cleaned, decision: state.decision, confidence: state.confidence, summary: state.summary,
    intent: state.intent, clarification: state.clarification, toolPlan: state.toolPlan, knowledge: state.knowledge, entityLinks: state.entityLinks, anchor: state.anchor, candidates: state.candidates, candidateEvidence: state.candidateEvidence,
    selectedCandidate: state.selectedCandidate, relations: state.relations, spatial: state.spatial, steps: state.steps,
    provenance: { orchestrator: "LangGraph", graphVersion: GRAPH_VERSION, retrievalMode: state.retrievalMode, llmMode: state.llmMode, knowledgeRag: { mode: state.knowledge.mode, hitCount: state.knowledge.hits.length }, coordinatePipeline: state.retrievalMode === "amap-online" ? "GCJ-02 → WGS84" : "WGS84 demo index", generatedAt: new Date().toISOString() },
  };
}
