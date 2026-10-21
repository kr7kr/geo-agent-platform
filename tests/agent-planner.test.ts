import assert from "node:assert/strict";
import test from "node:test";
import { searchAmapPois } from "../lib/agent/amap";
import { linkSpatialIntent } from "../lib/agent/entity-linker";
import { enrichIntentWithConfiguredLlm } from "../lib/agent/llm";
import { planWithRules } from "../lib/agent/planner";
import { isExactVerified, rankCandidates } from "../lib/agent/ranker";
import type { Candidate } from "../lib/agent/types";

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "fixture", name: "候选", address: "北京市海淀区", category: "餐饮服务", source: "amap", sourceRank: 0,
    location: [116.336, 39.993], crs: "WGS84", sourceCrs: "GCJ-02", score: 0.5, evidence: [],
    ...overrides,
  };
}

test("将商圈前缀解析为锚点和品牌目标", () => {
  const { intent } = planWithRules("五道口管氏翅吧");
  assert.equal(intent.type, "ANCHOR_TARGET");
  assert.equal(intent.anchors[0]?.name, "五道口");
  assert.equal(intent.target?.name, "管氏翅吧");
});

test("将口语找店表达解析为锚点和目标", () => {
  const { intent } = planWithRules("我在五道口找管氏翅吧");
  assert.equal(intent.type, "ANCHOR_TARGET");
  assert.equal(intent.anchors[0]?.name, "五道口");
  assert.equal(intent.target?.brand, "管氏翅吧");
});

test("高校简称锚点被链接为可验证标准实体", () => {
  const planned = planWithRules("北航附近的麦当劳").intent;
  const linked = linkSpatialIntent(planned);
  assert.equal(linked.intent.anchors[0]?.name, "北京航空航天大学");
  assert.equal(linked.intent.anchors[0]?.originalMention, "北航");
  assert.equal(linked.intent.adminHints.find((hint) => hint.level === "city")?.name, "北京市");
  assert.equal(linked.intent.queryPlan[0]?.query, "北京航空航天大学");
  assert.equal(linked.links.find((link) => link.role === "anchor")?.status, "LINKED");
});

test("北科大和北矿大可作为直接目标链接", () => {
  const beike = linkSpatialIntent(planWithRules("北科大").intent);
  const kuangda = linkSpatialIntent(planWithRules("北矿大").intent);
  assert.equal(beike.intent.target?.name, "北京科技大学");
  assert.equal(beike.intent.target?.originalMention, "北科大");
  assert.equal(kuangda.intent.target?.name, "中国矿业大学（北京）");
  assert.equal(kuangda.intent.target?.originalMention, "北矿大");
});

test("LLM 标准实体候选可覆盖未登记简称，并由 POI 类型约束过滤误召回", () => {
  const anli = linkSpatialIntent(planWithRules("安理").intent, [{
    role: "target",
    mention: "安理",
    candidates: [{
      canonicalName: "安徽理工大学", entityType: "university", city: "淮南市",
      confidence: 0.88, rationale: "高校常用简称",
    }],
  }]);
  assert.equal(anli.intent.target?.name, "安徽理工大学");
  assert.equal(anli.links[0]?.candidates[0]?.source, "llm");

  const anliRanked = rankCandidates([
    candidate({ id: "anli-home", name: "安理家园", category: "商务住宅·住宅区", address: "安徽省淮南市" }),
    candidate({ id: "ahut", name: "安徽理工大学", category: "科教文化服务·高等院校", address: "安徽省淮南市" }),
  ], anli.intent);
  assert.equal(anliRanked.candidates[0]?.id, "ahut");
  assert.equal(anliRanked.candidates.some((item) => item.id === "anli-home"), false);

  const xjtu = linkSpatialIntent(planWithRules("西安交大").intent, [{
    role: "target",
    mention: "西安交大",
    candidates: [{
      canonicalName: "西安交通大学", entityType: "university", city: "西安市",
      confidence: 0.9, rationale: "高校常用简称",
    }],
  }]);
  const xjtuRanked = rankCandidates([
    candidate({ id: "south-bus", name: "交大南门公交站", category: "交通设施服务·公交车站", address: "陕西省西安市" }),
    candidate({ id: "xjtu", name: "西安交通大学", category: "科教文化服务·高等院校", address: "陕西省西安市" }),
  ], xjtu.intent);
  assert.equal(xjtuRanked.candidates[0]?.id, "xjtu");
  assert.equal(xjtuRanked.candidates.some((item) => item.id === "south-bus"), false);
});

test("歧义简称不在无地域线索时强行链接", () => {
  const ambiguous = linkSpatialIntent(planWithRules("地大附近的麦当劳").intent);
  assert.equal(ambiguous.links.find((link) => link.role === "anchor")?.status, "AMBIGUOUS");
  assert.equal(ambiguous.intent.anchors[0]?.name, "地大");
  assert.equal(ambiguous.intent.needsClarification, true);

  const beijing = linkSpatialIntent(planWithRules("北京的地大附近的麦当劳").intent);
  assert.equal(beijing.links.find((link) => link.role === "anchor")?.status, "LINKED");
  assert.equal(beijing.intent.anchors[0]?.name, "中国地质大学（北京）");
});

test("锚点、地址和距离优先于无序字符重合", () => {
  const { intent } = planWithRules("我在五道口找管氏翅吧");
  const right = candidate({
    id: "wudaokou", name: "管氏翅吧(五道口东源大厦店)",
    address: "北京市海淀区成府路35号东源大厦(五道口地铁站)", distanceMeters: 180, sourceRank: 1,
  });
  const wrong = candidate({
    id: "liudaokou", name: "管氏翅吧(六道口店)",
    address: "北京市海淀区学院路六道口", distanceMeters: 1400, sourceRank: 0,
  });
  const ranked = rankCandidates([wrong, right], intent).candidates;
  assert.equal(ranked[0]?.id, "wudaokou");
});

test("显式区县冲突在排序前被硬淘汰", () => {
  const { intent } = planWithRules("北京市海淀区管氏翅吧");
  const result = rankCandidates([candidate({
    id: "chaoyang-store",
    name: "管氏翅吧(朝阳店)",
    address: "北京市朝阳区望京街道",
  })], intent);
  assert.equal(result.candidates.length, 0);
  assert.match(result.evidence[0]?.reasons.join(" ") ?? "", /区县提示/);
});

test("完整且唯一的分店名称可作为精确定位候选", () => {
  const { intent } = planWithRules("北京市海淀区管氏翅吧（五道口东源大厦店）");
  const exact = candidate({
    id: "exact", name: "管氏翅吧(五道口东源大厦店)",
    address: "北京市海淀区成府路35号东源大厦2层202室(五道口地铁站)",
  });
  const ranked = rankCandidates([exact], intent).candidates[0]!;
  assert.equal(isExactVerified(ranked, intent), true);
  assert.ok(ranked.score >= 0.78);
});

test("学校附近目标走锚点周边检索计划", () => {
  const { intent } = planWithRules("中国地质大学（北京）附近的麦当劳");
  assert.equal(intent.type, "ANCHOR_TARGET");
  assert.equal(intent.anchors[0]?.name, "中国地质大学（北京）");
  assert.equal(intent.target?.name, "麦当劳");
  assert.equal(intent.queryPlan[1]?.stage, "around");
});

test("方向距离表达保留参照地标，不被误作全国 POI 名称", () => {
  const { intent } = planWithRules("望京SOHO东侧约300米");
  assert.equal(intent.type, "RELATIONAL");
  assert.equal(intent.target, null);
  assert.equal(intent.anchors[0]?.name, "望京SOHO");
  assert.equal(intent.constraints.find((item) => item.kind === "distance")?.distanceMeters, 300);
});

test("缺少目标的附近表达请求澄清而不构造全国目标查询", () => {
  const { intent } = planWithRules("火星基地附近");
  assert.equal(intent.target, null);
  assert.equal(intent.anchors[0]?.name, "火星基地");
  assert.equal(intent.needsClarification, true);
  assert.equal(intent.queryPlan.some((item) => item.stage === "target"), false);
});

test("没有明确空间锚点的品牌不被强行视为精确门店", () => {
  const { intent } = planWithRules("管氏翅吧");
  assert.equal(intent.type, "DIRECT_POI");
  assert.equal(intent.anchors.length, 0);

  const [rankedCandidate] = rankCandidates([candidate({
    name: "管氏翅吧(五道口东源大厦店)",
    address: "北京市海淀区成府路35号东源大厦",
  })], intent).candidates;
  assert.equal(isExactVerified(rankedCandidate, intent), false);
});

test("高德文本检索使用城市严格限制并保留坐标来源", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      status: "1",
      pois: [{
        id: "mock-amap", name: "管氏翅吧(五道口东源大厦店)", location: "116.336463,39.993139",
        cityname: "北京市", adname: "海淀区", address: "成府路35号东源大厦", type: "餐饮服务",
      }],
    }));
  }) as typeof fetch;
  try {
    const results = await searchAmapPois("管氏翅吧", "北京市", "mock-key");
    assert.equal(results[0]?.sourceCrs, "GCJ-02");
    assert.equal(results[0]?.crs, "WGS84");
    assert.equal(results[0]?.retrieval?.operation, "text");
    assert.equal(results[0]?.retrieval?.region, "北京市");
    assert.match(requestedUrl, /city_limit=true/);
    assert.match(requestedUrl, /region=%E5%8C%97%E4%BA%AC%E5%B8%82/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM 结构化意图经过 schema 校验且不携带坐标", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    provider: process.env.AGENT_LLM_PROVIDER,
    baseUrl: process.env.AGENT_LLM_BASE_URL,
    apiKey: process.env.AGENT_LLM_API_KEY,
    model: process.env.AGENT_LLM_MODEL,
  };
  process.env.AGENT_LLM_PROVIDER = "cloud";
  process.env.AGENT_LLM_BASE_URL = "https://mock-llm.invalid";
  process.env.AGENT_LLM_API_KEY = "mock-key";
  process.env.AGENT_LLM_MODEL = "mock-model";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      type: "ANCHOR_TARGET",
      target: { name: "管氏翅吧", brand: "管氏翅吧" },
      anchors: [{ name: "五道口", relation: "NEAR" }],
      adminHints: [], constraints: [], needsClarification: false,
      entity_link_hints: [{
        role: "anchor", mention: "安理", candidates: [{
          canonical_name: "安徽理工大学", entity_type: "university", city: "淮南市", confidence: 0.88, reason: "高校简称",
        }],
      }],
    }) } }],
  }))) as typeof fetch;
  try {
    const rule = planWithRules("我在五道口找管氏翅吧").intent;
    const result = await enrichIntentWithConfiguredLlm("我在五道口找管氏翅吧", rule);
    assert.equal(result.mode, "cloud");
    assert.equal(result.intent?.anchors?.[0]?.name, "五道口");
    assert.equal(result.entityLinkHints[0]?.candidates[0]?.canonicalName, "安徽理工大学");
    assert.equal("location" in (result.intent?.target ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.AGENT_LLM_PROVIDER = previous.provider;
    process.env.AGENT_LLM_BASE_URL = previous.baseUrl;
    process.env.AGENT_LLM_API_KEY = previous.apiKey;
    process.env.AGENT_LLM_MODEL = previous.model;
  }
});

test("DeepSeek 空 content 会关闭思考模式并进行一次格式重试", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    provider: process.env.AGENT_LLM_PROVIDER,
    baseUrl: process.env.AGENT_LLM_BASE_URL,
    apiKey: process.env.AGENT_LLM_API_KEY,
    model: process.env.AGENT_LLM_MODEL,
  };
  let calls = 0;
  process.env.AGENT_LLM_PROVIDER = "cloud";
  process.env.AGENT_LLM_BASE_URL = "https://api.deepseek.com";
  process.env.AGENT_LLM_API_KEY = "mock-key";
  process.env.AGENT_LLM_MODEL = "deepseek-chat";
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { thinking?: { type?: string } };
    assert.deepEqual(body.thinking, { type: "disabled" });
    if (calls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ type: "DIRECT_POI", target: { name: "安徽理工大学" } }) }, finish_reason: "stop" }],
    }));
  }) as typeof fetch;
  try {
    const rule = planWithRules("安理").intent;
    const result = await enrichIntentWithConfiguredLlm("安理", rule);
    assert.equal(result.mode, "cloud");
    assert.equal(calls, 2);
    assert.equal(result.intent?.target?.name, "安徽理工大学");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.AGENT_LLM_PROVIDER = previous.provider;
    process.env.AGENT_LLM_BASE_URL = previous.baseUrl;
    process.env.AGENT_LLM_API_KEY = previous.apiKey;
    process.env.AGENT_LLM_MODEL = previous.model;
  }
});

test("LLM 空 HTTP 响应转为可诊断错误而不是 JSON 解析异常", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    provider: process.env.AGENT_LLM_PROVIDER,
    baseUrl: process.env.AGENT_LLM_BASE_URL,
    apiKey: process.env.AGENT_LLM_API_KEY,
    model: process.env.AGENT_LLM_MODEL,
  };
  process.env.AGENT_LLM_PROVIDER = "cloud";
  process.env.AGENT_LLM_BASE_URL = "https://mock-llm.invalid";
  process.env.AGENT_LLM_API_KEY = "mock-key";
  process.env.AGENT_LLM_MODEL = "mock-model";
  globalThis.fetch = (async () => new Response("")) as typeof fetch;
  try {
    const result = await enrichIntentWithConfiguredLlm("安理", planWithRules("安理").intent);
    assert.equal(result.mode, "fallback");
    assert.match(result.error ?? "", /LLM_EMPTY_RESPONSE/);
    assert.doesNotMatch(result.error ?? "", /Unexpected end of JSON input/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.AGENT_LLM_PROVIDER = previous.provider;
    process.env.AGENT_LLM_BASE_URL = previous.baseUrl;
    process.env.AGENT_LLM_API_KEY = previous.apiKey;
    process.env.AGENT_LLM_MODEL = previous.model;
  }
});
