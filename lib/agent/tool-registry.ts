import { z } from "zod";
import { searchAmapNearbyPois, searchAmapPois } from "./amap";
import { searchDemoCatalog } from "./catalog";
import { linkSpatialIntent } from "./entity-linker";
import { retrieveKnowledge } from "./knowledge-graph";
import type {
  AgentToolPlan,
  Candidate,
  EntityLinkResult,
  KnowledgeRetrieval,
  LlmEntityLinkHint,
  SpatialIntent,
} from "./types";

/**
 * The registry is the only place where graph nodes obtain provider tools.
 * Descriptors are deliberately key-free so they can be exposed through MCP.
 * Every executable tool is read-only and returns provenance with its result.
 */
export interface AgentToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    openWorldHint: boolean;
  };
}

export interface AgentToolResult {
  candidates?: Candidate[];
  links?: EntityLinkResult[];
  intent?: SpatialIntent;
  knowledge?: KnowledgeRetrieval;
  retrievalMode?: "amap-online" | "demo-fallback";
  provenance: Record<string, unknown>;
  [key: string]: unknown;
}

type ToolHandler = (args: unknown) => Promise<AgentToolResult>;

interface RegisteredTool extends AgentToolDescriptor {
  parse: (args: unknown) => unknown;
  execute: ToolHandler;
}

const textSchema = z.string().trim().min(1).max(200);
const regionSchema = z.string().trim().min(1).max(100).nullable().optional();
const coordinateSchema = z.tuple([z.number().finite(), z.number().finite()]);

const searchInput = z.object({
  query: textSchema,
  region: regionSchema,
  mentions: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();

const anchorInput = z.object({
  query: textSchema,
  region: regionSchema,
}).strict();

const aroundInput = z.object({
  query: textSchema,
  anchor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    address: z.string(),
    category: z.string(),
    source: z.enum(["amap", "demo-index"]),
    sourceRank: z.number().int().nonnegative(),
    location: coordinateSchema,
    crs: z.literal("WGS84"),
  }).passthrough(),
  radiusMeters: z.number().finite().min(100).max(50_000).optional(),
  mentions: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();

const distanceInput = z.object({
  from: coordinateSchema,
  to: coordinateSchema,
}).strict();

const entityLinkInput = z.object({
  intent: z.record(z.unknown()),
  hints: z.array(z.record(z.unknown())).max(20).optional(),
  knowledge: z.array(z.record(z.unknown())).max(12).optional(),
}).strict();

const knowledgeInput = z.object({
  text: textSchema,
}).strict();

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new Error(`INVALID_TOOL_ARGUMENTS: ${result.error.issues[0]?.message ?? "invalid input"}`);
  return result.data;
}

function configuredAmapKey() {
  // Credentials are read only at execution time and never enter a result,
  // descriptor, trace, or error message.
  return process.env.AMAP_WEB_SERVICE_KEY?.trim() || null;
}

function withDemoProvenance(candidates: Candidate[], query: string, region: string | null, operation: "text" | "around") {
  return candidates.map((candidate) => ({
    ...candidate,
    retrieval: {
      operation: "demo" as const,
      query,
      region,
      ...(operation === "around" ? { radiusMeters: 3_000 } : {}),
      sourceRank: candidate.sourceRank,
    },
  }));
}

function validCoordinate(point: [number, number]) {
  return point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
}

function distanceMeters(from: [number, number], to: [number, number]) {
  const radians = Math.PI / 180;
  const dLat = (to[1] - from[1]) * radians;
  const dLng = (to[0] - from[0]) * radians;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(from[1] * radians) * Math.cos(to[1] * radians) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function executeText(args: unknown): Promise<AgentToolResult> {
  const input = parse(searchInput, args);
  const region = input.region ?? null;
  const key = configuredAmapKey();
  if (key) {
    const candidates = await searchAmapPois(input.query, region, key);
    return {
      candidates,
      retrievalMode: "amap-online",
      provenance: { operation: "text", provider: "amap", query: input.query, region, cityLimit: Boolean(region) },
    };
  }
  const candidates = withDemoProvenance(searchDemoCatalog(input.query, input.mentions ?? [input.query]), input.query, region, "text");
  return {
    candidates,
    retrievalMode: "demo-fallback",
    provenance: { operation: "text", provider: "demo-index", query: input.query, region, fallback: "AMAP_WEB_SERVICE_KEY not configured" },
  };
}

async function executeAnchor(args: unknown): Promise<AgentToolResult> {
  const input = parse(anchorInput, args);
  return executeText({ query: input.query, region: input.region, mentions: [input.query] });
}

async function executeAround(args: unknown): Promise<AgentToolResult> {
  const input = parse(aroundInput, args);
  const radiusMeters = input.radiusMeters ?? 3_000;
  const key = configuredAmapKey();
  if (key) {
    const candidates = await searchAmapNearbyPois(input.query, input.anchor as unknown as Candidate, key, radiusMeters);
    return {
      candidates,
      retrievalMode: "amap-online",
      provenance: { operation: "around", provider: "amap", query: input.query, radiusMeters, anchorId: input.anchor.id, anchorName: input.anchor.name },
    };
  }
  const candidates = withDemoProvenance(searchDemoCatalog(input.query, input.mentions ?? [input.query]), input.query, null, "around");
  return {
    candidates,
    retrievalMode: "demo-fallback",
    provenance: { operation: "around", provider: "demo-index", query: input.query, radiusMeters, anchorId: input.anchor.id, fallback: "AMAP_WEB_SERVICE_KEY not configured" },
  };
}

async function executeDistance(args: unknown): Promise<AgentToolResult> {
  const input = parse(distanceInput, args);
  if (!validCoordinate(input.from) || !validCoordinate(input.to)) throw new Error("INVALID_COORDINATE");
  return {
    meters: distanceMeters(input.from, input.to),
    crs: "WGS84",
    provenance: { operation: "distance", method: "haversine", inputCrs: "WGS84" },
  };
}

async function executeEntityLink(args: unknown): Promise<AgentToolResult> {
  const input = parse(entityLinkInput, args);
  const result = linkSpatialIntent(
    input.intent as unknown as SpatialIntent,
    (input.hints ?? []) as unknown as LlmEntityLinkHint[],
    (input.knowledge ?? []) as unknown as KnowledgeRetrieval["hits"],
  );
  return { intent: result.intent, links: result.links, provenance: { operation: "entity-link", provider: "curated-alias-graph-and-llm-proposals" } };
}

async function executeKnowledgeRetrieve(args: unknown): Promise<AgentToolResult> {
  const input = parse(knowledgeInput, args);
  const knowledge = retrieveKnowledge(input.text);
  return {
    knowledge,
    provenance: {
      operation: "knowledge-retrieve",
      provider: "local-geographic-knowledge-graph",
      query: input.text,
      corpusSize: knowledge.corpusSize,
      hitCount: knowledge.hits.length,
      coordinatePolicy: "no-coordinates",
    },
  };
}

const registry: RegisteredTool[] = [
  {
    name: "geo.retrieve_knowledge",
    title: "地理知识图谱 RAG",
    description: "从本地图谱召回实体别名、行政区和关系线索；仅用于查询扩展与消歧，不返回坐标或最终结论。",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    parse: (args) => parse(knowledgeInput, args), execute: executeKnowledgeRetrieve,
  },
  {
    name: "geo.entity_link",
    title: "口语实体链接",
    description: "将简称、别名和口语化地名链接为待验证的标准实体；不生成坐标。",
    inputSchema: { type: "object", required: ["intent"], properties: { intent: { type: "object" }, hints: { type: "array" }, knowledge: { type: "array" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    parse: (args) => parse(entityLinkInput, args), execute: executeEntityLink,
  },
  {
    name: "geo.search_text",
    title: "文本 POI 搜索",
    description: "按查询词和可选城市/区县限制检索 POI；高德坐标转换为 WGS84 并保留 GCJ-02 provenance。",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 }, region: { type: ["string", "null"] }, mentions: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    parse: (args) => parse(searchInput, args), execute: executeText,
  },
  {
    name: "geo.resolve_anchor",
    title: "锚点解析",
    description: "在行政区约束下验证空间关系中的参照地标，避免全国盲猜。",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 }, region: { type: ["string", "null"] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    parse: (args) => parse(anchorInput, args), execute: executeAnchor,
  },
  {
    name: "geo.search_around",
    title: "锚点周边 POI 搜索",
    description: "围绕已经验证的 WGS84 锚点检索目标 POI，并保留距离与半径 provenance。",
    inputSchema: { type: "object", required: ["query", "anchor"], properties: { query: { type: "string" }, anchor: { type: "object" }, radiusMeters: { type: "number", minimum: 100, maximum: 50000 }, mentions: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    parse: (args) => parse(aroundInput, args), execute: executeAround,
  },
  {
    name: "geo.distance",
    title: "WGS84 距离计算",
    description: "计算两个 WGS84 点之间的球面距离；不调用外部服务。",
    inputSchema: { type: "object", required: ["from", "to"], properties: { from: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 }, to: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    parse: (args) => parse(distanceInput, args), execute: executeDistance,
  },
];

export function listAgentToolDefinitions(): AgentToolDescriptor[] {
  return registry.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

export function getAgentTool(name: string) {
  return registry.find((tool) => tool.name === name) ?? null;
}

export async function executeAgentTool(name: string, args: unknown): Promise<AgentToolResult> {
  const tool = getAgentTool(name);
  if (!tool) throw new Error(`UNKNOWN_AGENT_TOOL: ${name}`);
  return tool.execute(args);
}

function regionFor(intent: SpatialIntent) {
  return intent.adminHints.find((hint) => hint.level === "district")?.name ??
    intent.adminHints.find((hint) => hint.level === "city")?.name ?? null;
}

/** Build a provider-agnostic executable plan before any external call. */
export function buildToolPlan(intent: SpatialIntent): AgentToolPlan[] {
  const region = regionFor(intent);
  const plan: AgentToolPlan[] = [
    { id: "geo.retrieve_knowledge", label: "地理知识图谱 RAG", stage: "knowledge", reason: "先召回实体别名、行政区与关系线索；只作为待验证查询先验" },
    { id: "geo.entity_link", label: "口语实体链接", stage: "link", reason: "融合别名库、图谱 RAG 与 LLM 提议，将口语化实体映射为候选标准实体", dependsOn: ["geo.retrieve_knowledge"] },
  ];
  const anchor = intent.anchors[0];
  const around = intent.queryPlan.find((item) => item.stage === "around");
  if (anchor) plan.push({ id: "geo.resolve_anchor", label: "锚点文本检索", stage: "anchor", reason: "验证空间关系中的参照地标，避免全国盲猜", query: anchor.name, region });
  if (intent.target && anchor && around) {
    plan.push({ id: "geo.search_around", label: "锚点周边检索", stage: "around", reason: "围绕已验证锚点检索目标并保留距离证据", query: around.query, region: around.region ?? region, radiusMeters: around.radiusMeters, dependsOn: ["geo.resolve_anchor"] });
  } else if (intent.target) {
    const target = intent.queryPlan.find((item) => item.stage === "target");
    plan.push({ id: "geo.search_text", label: "目标文本检索", stage: "target", reason: "对直接目标执行城市/区县受限的文本 POI 检索", query: target?.query ?? intent.target.name, region: target?.region ?? region });
  }
  plan.push({ id: "agent.verify_evidence", label: "证据与硬约束验证", stage: "verify", reason: "先淘汰城市、实体类型、分店和距离冲突，再计算决策分数" });
  plan.push({ id: "agent.adaptive_s2", label: "自适应 S2 空间化", stage: "spatial", reason: "仅对 RESOLVED/COARSE 结果输出与不确定性匹配的网格", dependsOn: ["agent.verify_evidence"] });
  return plan;
}
