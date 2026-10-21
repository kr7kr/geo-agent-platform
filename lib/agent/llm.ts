import { z } from "zod";
import type { EntityType, LlmEntityLinkHint, SpatialIntent } from "./types";

export type LlmMode = "disabled" | "local" | "cloud" | "fallback";

export interface IntentEnrichment {
  intent: Partial<SpatialIntent> | null;
  entityLinkHints: LlmEntityLinkHint[];
  mode: LlmMode;
  error?: string;
}

const IntentSchema = z.object({
  type: z.enum(["DIRECT_POI", "ANCHOR_TARGET", "ADDRESS", "RELATIONAL", "AMBIGUOUS"]).optional(),
  target: z.object({
    name: z.string().min(2).max(80),
    brand: z.string().min(2).max(80).optional(),
    category: z.string().min(1).max(40).optional(),
    branchQualifier: z.string().min(2).max(80).optional(),
  }).nullable().optional(),
  anchors: z.array(z.object({
    name: z.string().min(2).max(80),
    relation: z.enum(["NEAR", "WITHIN", "DIRECTIONAL", "AT"]),
    distanceMeters: z.number().int().min(1).max(50_000).optional(),
    direction: z.string().min(1).max(10).optional(),
  })).max(3).optional(),
  adminHints: z.array(z.object({
    name: z.string().min(2).max(40),
    level: z.enum(["province", "city", "district", "business_area"]),
    // The model may infer a hint from text, but verification is reserved for
    // provider evidence gathered by the graph.
    status: z.enum(["explicit", "inferred"]),
  })).max(5).optional(),
  constraints: z.array(z.object({
    kind: z.enum(["distance", "direction", "within", "address"]),
    value: z.string().min(1).max(80),
    distanceMeters: z.number().int().min(1).max(50_000).optional(),
    direction: z.string().min(1).max(10).optional(),
  })).max(5).optional(),
  needsClarification: z.boolean().optional(),
});

const EntityLinkHintsSchema = z.array(z.object({
    role: z.enum(["target", "anchor"]),
    mention: z.string().min(2).max(80),
    candidates: z.array(z.object({
      canonicalName: z.string().min(2).max(100),
      queryName: z.string().min(2).max(100).optional(),
      entityType: z.enum(["university", "hospital", "station", "landmark", "commercial_area", "organization", "unknown"]),
      city: z.string().min(2).max(40).optional(),
      district: z.string().min(2).max(40).optional(),
      confidence: z.number().min(0).max(1),
      rationale: z.string().min(2).max(160),
    })).max(3),
  })).max(6);

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
}

type MessageContent = string | Array<{ type?: string; text?: string }> | undefined;

function configuredMode(): Exclude<LlmMode, "fallback"> {
  const provider = process.env.AGENT_LLM_PROVIDER?.trim().toLowerCase();
  const baseUrl = process.env.AGENT_LLM_BASE_URL?.trim();
  const model = process.env.AGENT_LLM_MODEL?.trim();
  if (!baseUrl || !model || !provider || provider === "rule") return "disabled";
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/i.test(baseUrl) ? "local" : "cloud";
}

function contentText(content: MessageContent) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function safeError(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "LLM_TIMEOUT：模型服务在配置的超时时间内没有返回，请检查网络、Base URL 或提高 AGENT_LLM_TIMEOUT_MS";
  }
  const message = error instanceof Error ? error.message : "LLM_UNAVAILABLE";
  if (message === "LLM_EMPTY_HTTP_BODY") {
    return "LLM_EMPTY_RESPONSE：模型服务返回空响应，请检查 Base URL、模型名和服务状态";
  }
  if (message === "LLM_INVALID_HTTP_JSON") {
    return "LLM_INVALID_RESPONSE：模型服务返回的不是有效 JSON，请检查 OpenAI-compatible 接口配置";
  }
  if (message === "LLM_EMPTY_CONTENT") {
    return "LLM_EMPTY_CONTENT：模型没有返回可解析内容，已尝试一次格式重试并回退到规则规划";
  }
  if (message === "LLM_OUTPUT_TRUNCATED") {
    return "LLM_OUTPUT_TRUNCATED：模型输出被截断，已尝试一次更大输出预算的重试";
  }
  if (message === "LLM_INVALID_JSON") {
    return "LLM_INVALID_JSON：模型返回内容无法解析为 JSON，已尝试一次格式重试并回退到规则规划";
  }
  if (error instanceof SyntaxError && /JSON/i.test(message)) {
    return "LLM_INVALID_RESPONSE：模型返回内容不是完整 JSON，已回退到规则规划";
  }
  if (/aborted|timeout|timed out/i.test(message)) {
    return "LLM_TIMEOUT：模型服务在配置的超时时间内没有返回，请检查网络、Base URL 或提高 AGENT_LLM_TIMEOUT_MS";
  }
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").slice(0, 120);
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("LLM_EMPTY_CONTENT");

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    // Some OpenAI-compatible models add a short sentence around the JSON.
    // Extract one balanced object without accepting arbitrary model text.
    const start = withoutFence.indexOf("{");
    if (start < 0) throw new Error("LLM_INVALID_JSON");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < withoutFence.length; index += 1) {
      const character = withoutFence[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(withoutFence.slice(start, index + 1)) as unknown;
          } catch {
            throw new Error("LLM_INVALID_JSON");
          }
        }
      }
    }
    throw new Error("LLM_INVALID_JSON");
  }
}

function recoverableFormatError(error: unknown) {
  return error instanceof Error && [
    "LLM_EMPTY_CONTENT",
    "LLM_OUTPUT_TRUNCATED",
    "LLM_INVALID_JSON",
  ].includes(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function entityType(value: unknown, name: string): EntityType {
  const raw = text(value).toLowerCase();
  if (["university", "hospital", "station", "landmark", "commercial_area", "organization", "unknown"].includes(raw)) return raw as EntityType;
  if (/大学|学院|高校|学校/.test(`${raw}${name}`)) return "university";
  if (/医院|医疗/.test(`${raw}${name}`)) return "hospital";
  if (/车站|地铁|公交|站/.test(`${raw}${name}`)) return "station";
  if (/商圈|商业/.test(`${raw}${name}`)) return "commercial_area";
  return "unknown";
}

function normalizedRelation(value: unknown) {
  const raw = text(value).toUpperCase();
  if (["NEAR", "WITHIN", "DIRECTIONAL", "AT"].includes(raw)) return raw;
  if (/附近|周边|靠近/.test(raw)) return "NEAR";
  if (/内|里面/.test(raw)) return "WITHIN";
  if (/东|西|南|北/.test(raw)) return "DIRECTIONAL";
  return "";
}

function sanitizeCoreIntent(payload: unknown) {
  if (!isRecord(payload)) return {};
  const type = text(payload.type).toUpperCase();
  const rawTarget = isRecord(payload.target) ? payload.target : isRecord(payload.targetEntity) ? payload.targetEntity : null;
  const targetName = text(rawTarget?.name ?? rawTarget?.entityName ?? rawTarget?.entity_name);
  const rawAnchors = payload.anchors ?? payload.anchorEntities ?? payload.anchor_entities;
  const anchors = Array.isArray(rawAnchors) ? rawAnchors.flatMap((anchor) => {
    if (!isRecord(anchor)) return [];
    const name = text(anchor.name ?? anchor.entityName ?? anchor.entity_name);
    const relation = normalizedRelation(anchor.relation ?? anchor.spatialRelation ?? anchor.spatial_relation);
    return name.length >= 2 && relation ? [{
      name, relation,
      ...(Number.isInteger(anchor.distanceMeters) ? { distanceMeters: anchor.distanceMeters } : {}),
      ...(text(anchor.direction) ? { direction: text(anchor.direction) } : {}),
    }] : [];
  }) : [];
  const rawHints = payload.adminHints ?? payload.admin_hints;
  const adminHints = Array.isArray(rawHints) ? rawHints.flatMap((hint) => {
    if (!isRecord(hint)) return [];
    const name = text(hint.name);
    const level = text(hint.level);
    const status = text(hint.status);
    return name.length >= 2 && ["province", "city", "district", "business_area"].includes(level) && ["explicit", "inferred"].includes(status)
      ? [{ name, level, status }]
      : [];
  }) : [];
  return {
    ...(["DIRECT_POI", "ANCHOR_TARGET", "ADDRESS", "RELATIONAL", "AMBIGUOUS"].includes(type) ? { type } : {}),
    ...(targetName.length >= 2 ? { target: {
      name: targetName,
      ...(text(rawTarget?.brand) ? { brand: text(rawTarget?.brand) } : {}),
      ...(text(rawTarget?.category) ? { category: text(rawTarget?.category) } : {}),
      ...(text(rawTarget?.branchQualifier ?? rawTarget?.branch_qualifier) ? { branchQualifier: text(rawTarget?.branchQualifier ?? rawTarget?.branch_qualifier) } : {}),
    } } : {}),
    ...(anchors.length ? { anchors: anchors.slice(0, 3) } : {}),
    ...(adminHints.length ? { adminHints: adminHints.slice(0, 5) } : {}),
    ...(typeof payload.needsClarification === "boolean" ? { needsClarification: payload.needsClarification } : {}),
  };
}

function parseEntityLinkHints(payload: unknown): LlmEntityLinkHint[] {
  if (!isRecord(payload)) return [];
  const rawHints = payload.entityLinkHints ?? payload.entity_link_hints ?? payload.entityLinks ?? payload.entity_links ?? payload.entityCandidates ?? payload.entity_candidates ?? payload.canonicalCandidates;
  if (!Array.isArray(rawHints)) return [];
  const normalized = rawHints.flatMap((rawHint) => {
    if (!isRecord(rawHint)) return [];
    const roleValue = text(rawHint.role ?? rawHint.entityRole ?? rawHint.entity_role);
    const role = roleValue === "anchor" ? "anchor" : "target";
    const mention = text(rawHint.mention ?? rawHint.entityMention ?? rawHint.entity_mention ?? rawHint.text);
    const rawCandidates = rawHint.candidates ?? rawHint.canonicalCandidates ?? rawHint.canonical_candidates ?? rawHint.entities ??
      (rawHint.canonicalName || rawHint.canonical_name ? [rawHint] : []);
    if (mention.length < 2 || !Array.isArray(rawCandidates)) return [];
    const candidates = rawCandidates.flatMap((rawCandidate) => {
      if (!isRecord(rawCandidate)) return [];
      const canonicalName = text(rawCandidate.canonicalName ?? rawCandidate.canonical_name ?? rawCandidate.name ?? rawCandidate.entityName ?? rawCandidate.entity_name);
      if (canonicalName.length < 2) return [];
      const numericConfidence = Number(rawCandidate.confidence ?? rawCandidate.score ?? rawCandidate.probability ?? 0.7);
      return [{
        canonicalName,
        ...(text(rawCandidate.queryName ?? rawCandidate.query_name) ? { queryName: text(rawCandidate.queryName ?? rawCandidate.query_name) } : {}),
        entityType: entityType(rawCandidate.entityType ?? rawCandidate.entity_type ?? rawCandidate.type, canonicalName),
        ...(text(rawCandidate.city) ? { city: text(rawCandidate.city) } : {}),
        ...(text(rawCandidate.district ?? rawCandidate.adname) ? { district: text(rawCandidate.district ?? rawCandidate.adname) } : {}),
        confidence: Number.isFinite(numericConfidence) ? Math.max(0, Math.min(1, numericConfidence)) : 0.7,
        rationale: text(rawCandidate.rationale ?? rawCandidate.reason ?? rawCandidate.explanation) || "LLM 提出的标准实体候选",
      }];
    });
    return candidates.length ? [{ role, mention, candidates: candidates.slice(0, 3) }] : [];
  });
  const parsed = EntityLinkHintsSchema.safeParse(normalized.slice(0, 6));
  return parsed.success ? parsed.data : [];
}

function inferredHintFromCanonicalIntent(intent: Partial<SpatialIntent>, ruleIntent: SpatialIntent): LlmEntityLinkHint[] {
  if (ruleIntent.target && intent.target && ruleIntent.target.name !== intent.target.name && intent.target.name.length > ruleIntent.target.name.length) {
    return [{
      role: "target",
      mention: ruleIntent.target.name,
      candidates: [{
        canonicalName: intent.target.name,
        entityType: entityType(intent.target.category, intent.target.name),
        confidence: 0.72,
        rationale: "LLM 在结构化意图中将口语提及扩展为标准名称",
      }],
    }];
  }
  const ruleAnchor = ruleIntent.anchors[0];
  const inferredAnchor = intent.anchors?.[0];
  if (ruleAnchor && inferredAnchor && ruleAnchor.name !== inferredAnchor.name && inferredAnchor.name.length > ruleAnchor.name.length) {
    return [{
      role: "anchor",
      mention: ruleAnchor.name,
      candidates: [{
        canonicalName: inferredAnchor.name,
        entityType: entityType(undefined, inferredAnchor.name),
        confidence: 0.72,
        rationale: "LLM 在结构化意图中将口语锚点扩展为标准名称",
      }],
    }];
  }
  return [];
}

export async function enrichIntentWithConfiguredLlm(text: string, ruleIntent: SpatialIntent): Promise<IntentEnrichment> {
  const mode = configuredMode();
  if (mode === "disabled") return { intent: null, entityLinkHints: [], mode };
  const baseUrl = process.env.AGENT_LLM_BASE_URL!.replace(/\/$/, "");
  const model = process.env.AGENT_LLM_MODEL!;
  const apiKey = process.env.AGENT_LLM_API_KEY?.trim();
  const configuredTimeout = Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 25_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(60_000, Math.max(5_000, configuredTimeout)) : 25_000;
  const isDeepSeek = /deepseek/i.test(`${baseUrl} ${model}`);
  const prompt = [
    "你是中文空间检索 Agent 的受约束语义规划器。只输出符合 schema 的 JSON，不要解释。",
    "识别目标实体、参照地标、行政区提示、显式空间关系、是否需要澄清，以及 entityLinkHints 中的口语简称标准实体候选。",
    "可以使用语言和领域常识理解简称，例如“安理”可提出“安徽理工大学”，“西安交大”可提出“西安交通大学”；这只是待验证的查询候选，不是事实确认。",
    "对存在多义的简称应返回多个候选或 needsClarification=true；没有把握时输出空数组，不要编造。",
    "严禁生成坐标、POI ID、地址事实、搜索结果或最终决策。",
    "行政区若只是从常识猜测，status 必须为 inferred；不要声称 verified。",
    "例如“我在五道口找管氏翅吧”：target=管氏翅吧，anchor=五道口，relation=NEAR。",
    "entityLinkHints 格式示例：{\"role\":\"target\",\"mention\":\"安理\",\"candidates\":[{\"canonicalName\":\"安徽理工大学\",\"entityType\":\"university\",\"confidence\":0.88,\"rationale\":\"高校简称\"}]}。",
    "输入：" + text,
    "规则初稿：" + JSON.stringify(ruleIntent),
  ].join("\n");
  const baseMessages = [
    { role: "system", content: "Return strict JSON only. Never infer coordinates." },
    { role: "user", content: prompt },
  ];
  const requests: Array<Record<string, unknown>> = [
    {
      model,
      temperature: 0,
      max_tokens: 1_200,
      response_format: { type: "json_object" },
      messages: baseMessages,
      ...(isDeepSeek ? { thinking: { type: "disabled" } } : {}),
    },
    {
      model,
      temperature: 0,
      max_tokens: 2_000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return one compact JSON object only. Do not return an empty response, markdown, or explanation. Never infer coordinates." },
        { role: "user", content: `${prompt}\n再次输出：必须包含至少一个 JSON 对象，即使没有可补充线索也返回 {"needsClarification":true}。` },
      ],
      ...(isDeepSeek ? { thinking: { type: "disabled" } } : {}),
    },
  ];

  let lastError: unknown = new Error("LLM_UNAVAILABLE");
  for (const request of requests) {
    try {
      const response = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error("LLM_HTTP_" + response.status);
      if (!responseText.trim()) throw new Error("LLM_EMPTY_HTTP_BODY");
      let payload: ChatCompletionResponse;
      try {
        payload = JSON.parse(responseText) as ChatCompletionResponse;
      } catch {
        throw new Error("LLM_INVALID_HTTP_JSON");
      }
      const choice = payload.choices?.[0];
      const raw = contentText(choice?.message?.content);
      if (!raw) {
        throw new Error(choice?.finish_reason === "length" ? "LLM_OUTPUT_TRUNCATED" : "LLM_EMPTY_CONTENT");
      }
      const decoded = parseJsonObject(raw);
      const parsed = IntentSchema.safeParse(sanitizeCoreIntent(decoded));
      if (!parsed.success) throw new Error("LLM_SCHEMA_INVALID");
      const parsedHints = parseEntityLinkHints(decoded);
      const entityLinkHints = parsedHints.length ? parsedHints : inferredHintFromCanonicalIntent(parsed.data, ruleIntent);
      return { intent: parsed.data, entityLinkHints, mode };
    } catch (error) {
      lastError = error;
      if (!recoverableFormatError(error)) break;
    }
  }
  return { intent: null, entityLinkHints: [], mode: "fallback", error: safeError(lastError) };
}
