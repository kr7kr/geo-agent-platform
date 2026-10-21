import { ENTITY_ALIAS_REGISTRY, type EntityAliasRecord } from "./entity-aliases";
import { normalizeText } from "./planner";
import type {
  AdministrativeHint,
  CanonicalEntityCandidate,
  EntityLinkResult,
  EntityRole,
  KnowledgeGraphHit,
  LlmEntityLinkHint,
  SpatialAnchor,
  SpatialIntent,
  TargetEntity,
} from "./types";

function unique<T>(items: T[], key: (item: T) => string) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function candidateFrom(record: EntityAliasRecord, mention: string): CanonicalEntityCandidate | null {
  const normalizedMention = normalizeText(mention);
  const variants = [record.canonicalName, ...record.aliases];
  const matchedAlias = variants.find((alias) => normalizeText(alias) === normalizedMention);
  if (!matchedAlias) return null;
  const isCanonical = normalizeText(record.canonicalName) === normalizedMention;
  return {
    canonicalName: record.canonicalName,
    queryName: record.canonicalName,
    aliases: record.aliases,
    entityType: record.entityType,
    ...(record.city ? { city: record.city } : {}),
    ...(record.district ? { district: record.district } : {}),
    aliasScore: isCanonical ? 1 : 0.98,
    source: "curated",
    evidence: [isCanonical ? "标准实体名称直接命中" : `本地别名“${matchedAlias}”命中`, `实体类型：${record.entityType}`],
  };
}

function explicitCity(intent: SpatialIntent) {
  return intent.adminHints.find((hint) => hint.level === "city" && hint.status === "explicit")?.name;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionWithoutAdministrativePrefix(mention: string, intent: SpatialIntent) {
  let value = mention.trim();
  const prefixes = intent.adminHints
    .filter((hint) => hint.level === "city" || hint.level === "district")
    .flatMap((hint) => [hint.name, hint.name.replace(/市$/, "")])
    .filter(Boolean);
  for (const prefix of prefixes) value = value.replace(new RegExp(`^${escapeRegExp(prefix)}(?:市)?的?`), "");
  return value.trim();
}

function contextFilter(candidates: CanonicalEntityCandidate[], intent: SpatialIntent) {
  const city = explicitCity(intent);
  const contextual = city ? candidates.filter((candidate) => candidate.city === city) : candidates;
  return unique(contextual.length ? contextual : candidates, (candidate) => candidate.canonicalName)
    .sort((left, right) => right.aliasScore - left.aliasScore || left.canonicalName.localeCompare(right.canonicalName, "zh-CN"));
}

function llmCandidatesForMention(role: EntityRole, mention: string, hints: LlmEntityLinkHint[]) {
  const normalizedMention = normalizeText(mention);
  return hints
    .filter((hint) => {
      if (hint.role !== role) return false;
      const hintedMention = normalizeText(hint.mention);
      // The rule planner may strip an explicit city before it emits a target
      // ("西安交大" → "交大"). Preserve the LLM's full contextual mention.
      return hintedMention === normalizedMention ||
        (normalizedMention.length >= 2 && hintedMention.endsWith(normalizedMention)) ||
        (hintedMention.length >= 2 && normalizedMention.endsWith(hintedMention));
    })
    .flatMap((hint) => hint.candidates.map((candidate) => ({
      canonicalName: candidate.canonicalName,
      queryName: candidate.queryName ?? candidate.canonicalName,
      aliases: [hint.mention],
      entityType: candidate.entityType,
      ...(candidate.city ? { city: candidate.city } : {}),
      ...(candidate.district ? { district: candidate.district } : {}),
      // Treat model confidence as a prior. It intentionally cannot outweigh
      // provider verification in later graph nodes.
      aliasScore: Math.min(0.9, candidate.confidence),
      source: "llm" as const,
      evidence: [`LLM 提出标准实体候选：${candidate.rationale}`, "尚待 POI 名称与类别证据验证"],
    })));
}

function graphCandidatesForMention(mention: string, hits: KnowledgeGraphHit[]): CanonicalEntityCandidate[] {
  const normalizedMention = normalizeText(mention);
  return hits.flatMap((hit) => {
    const matchedAlias = [hit.canonicalName, ...hit.aliases]
      .find((alias) => normalizeText(alias) === normalizedMention);
    if (!matchedAlias) return [];
    const isCanonical = normalizeText(hit.canonicalName) === normalizedMention;
    return [{
      canonicalName: hit.canonicalName,
      queryName: hit.canonicalName,
      aliases: hit.aliases,
      entityType: hit.entityType,
      ...(hit.city ? { city: hit.city } : {}),
      ...(hit.district ? { district: hit.district } : {}),
      aliasScore: isCanonical ? 1 : Math.min(0.97, Math.max(0.76, hit.score)),
      source: "knowledge_graph" as const,
      evidence: [
        `知识图谱 RAG 命中本地实体“${hit.canonicalName}”`,
        ...hit.facts.slice(1),
        ...hit.relations,
        "图谱线索尚待 POI 名称、类别与地址证据验证",
      ],
    }];
  });
}

function enrichWithGraphEvidence(candidates: CanonicalEntityCandidate[], hits: KnowledgeGraphHit[]) {
  return candidates.map((candidate) => {
    const hit = hits.find((item) => item.canonicalName === candidate.canonicalName);
    if (!hit) return candidate;
    return {
      ...candidate,
      evidence: unique([
        ...candidate.evidence,
        `知识图谱 RAG 补充：${hit.matchedTerms.join("、")} 命中“${hit.canonicalName}”`,
        ...hit.relations,
      ], (item) => item),
    };
  });
}

function candidatesForMention(role: EntityRole, mention: string, intent: SpatialIntent, hints: LlmEntityLinkHint[], knowledge: KnowledgeGraphHit[]) {
  const normalizedMention = mentionWithoutAdministrativePrefix(mention, intent);
  const local = ENTITY_ALIAS_REGISTRY.flatMap((record) => {
    const candidate = candidateFrom(record, normalizedMention);
    return candidate ? [candidate] : [];
  });
  const graph = graphCandidatesForMention(normalizedMention, knowledge);
  // Audited local aliases take precedence; model candidates fill coverage gaps.
  if (local.length) return contextFilter(enrichWithGraphEvidence(local, knowledge), intent);
  if (graph.length) return contextFilter(graph, intent);
  return contextFilter(llmCandidatesForMention(role, normalizedMention, hints), intent);
}

function linkMention(role: EntityRole, mention: string, intent: SpatialIntent, hints: LlmEntityLinkHint[], knowledge: KnowledgeGraphHit[]): EntityLinkResult {
  const normalizedMention = mentionWithoutAdministrativePrefix(mention, intent);
  const candidates = candidatesForMention(role, mention, intent, hints, knowledge);
  if (!candidates.length) return { role, mention, status: "UNLINKED", candidates: [], evidence: ["本地别名库没有匹配项，保留原始文本检索"] };
  if (candidates.length > 1) {
    return {
      role, mention, status: "AMBIGUOUS", candidates,
      evidence: [`“${mention}”可指向 ${candidates.map((candidate) => candidate.canonicalName).join("、")}，缺少可消歧上下文`],
    };
  }
  const selected = candidates[0];
  if (selected.source === "llm" && selected.aliasScore < 0.72) {
    return {
      role, mention, status: "AMBIGUOUS", candidates,
      evidence: [`LLM 对“${mention}”的实体候选先验不足，需补充城市、全称或更多上下文`],
    };
  }
  return {
    role, mention, status: "LINKED", candidates,
    selectedCanonicalName: selected.canonicalName,
    evidence: [...selected.evidence, ...(normalizedMention !== mention ? [`已使用行政区上下文规范化“${mention}”`] : []), ...(selected.city ? [`注册城市提示：${selected.city}`] : [])],
  };
}

function linkTarget(target: TargetEntity, link: EntityLinkResult): TargetEntity {
  const selected = link.candidates[0];
  if (link.status !== "LINKED" || !selected) return target;
  return {
    ...target,
    name: selected.queryName,
    brand: selected.queryName,
    originalMention: link.mention,
    entityType: selected.entityType,
    entityLinkScore: selected.aliasScore,
  };
}

function linkAnchor(anchor: SpatialAnchor, link: EntityLinkResult): SpatialAnchor {
  const selected = link.candidates[0];
  if (link.status !== "LINKED" || !selected) return anchor;
  return {
    ...anchor,
    name: selected.queryName,
    originalMention: link.mention,
    entityType: selected.entityType,
    entityLinkScore: selected.aliasScore,
  };
}

function linkedAdministrativeHints(intent: SpatialIntent, links: EntityLinkResult[]): AdministrativeHint[] {
  const inferred = links.flatMap((link) => link.status === "LINKED" ? link.candidates.slice(0, 1).flatMap((candidate) => [
    ...(candidate.city ? [{ name: candidate.city, level: "city" as const, status: "inferred" as const }] : []),
    ...(candidate.district ? [{ name: candidate.district, level: "district" as const, status: "inferred" as const }] : []),
  ]) : []);
  return unique([...intent.adminHints, ...inferred], (hint) => `${hint.level}:${hint.name}`);
}

function rebuildQueryPlan(intent: SpatialIntent): SpatialIntent["queryPlan"] {
  const region = intent.adminHints.find((hint) => hint.level === "district")?.name ??
    intent.adminHints.find((hint) => hint.level === "city")?.name ?? null;
  if (intent.anchors.length && intent.target) {
    const anchor = intent.anchors[0];
    return [
      { stage: "anchor", query: anchor.name, region, reason: anchor.originalMention ? "先以标准实体名称验证简称锚点" : "先验证参照地标" },
      { stage: "around", query: intent.target.name, region, radiusMeters: anchor.distanceMeters ? Math.max(300, Math.min(10_000, anchor.distanceMeters * 2)) : 3_000, reason: "在已验证参照点附近检索目标实体" },
    ];
  }
  if (intent.target) return [{ stage: "target", query: intent.target.name, region, reason: intent.target.originalMention ? "以标准实体名称检索简称目标" : "直接名称检索" }];
  if (intent.anchors.length) return [{ stage: "anchor", query: intent.anchors[0].name, region, reason: "验证参照地标" }];
  return [];
}

export function linkSpatialIntent(intent: SpatialIntent, llmHints: LlmEntityLinkHint[] = [], knowledge: KnowledgeGraphHit[] = []): { intent: SpatialIntent; links: EntityLinkResult[] } {
  const links = [
    ...(intent.target ? [linkMention("target", intent.target.name, intent, llmHints, knowledge)] : []),
    ...intent.anchors.map((anchor) => linkMention("anchor", anchor.name, intent, llmHints, knowledge)),
  ];
  const targetLink = links.find((link) => link.role === "target");
  const anchors = intent.anchors.map((anchor, index) => linkAnchor(anchor, links.filter((link) => link.role === "anchor")[index]));
  const linked = {
    ...intent,
    ...(intent.target && targetLink ? { target: linkTarget(intent.target, targetLink) } : {}),
    anchors,
    adminHints: linkedAdministrativeHints(intent, links),
    needsClarification: intent.needsClarification || links.some((link) => link.status === "AMBIGUOUS"),
  };
  return { intent: { ...linked, queryPlan: rebuildQueryPlan(linked) }, links };
}
