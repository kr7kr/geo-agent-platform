import type {
  AdministrativeHint,
  RelationEvidence,
  SpatialAnchor,
  SpatialConstraint,
  SpatialIntent,
  TargetEntity,
} from "./types";

const CITY_ALIASES = [
  ["北京市", "北京"], ["上海市", "上海"], ["天津市", "天津"], ["重庆市", "重庆"],
  ["广州市", "广州"], ["深圳市", "深圳"], ["苏州市", "苏州"], ["杭州市", "杭州"],
  ["南京市", "南京"], ["成都市", "成都"], ["武汉市", "武汉"], ["西安市", "西安"],
] as const;

const DISTRICT_HINTS = ["海淀区", "朝阳区", "东城区", "西城区", "昌平区", "通州区"];
const BUSINESS_ANCHORS = ["五道口", "六道口", "望京", "中关村", "国贸", "三里屯", "天河城"];

export function normalizeText(value: string) {
  return value.toLowerCase().replace(/[\s·（）()\-，,。；;：:]/g, "");
}

function unique<T>(items: T[], key: (item: T) => string) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function administrativeHints(text: string): AdministrativeHint[] {
  const cities = CITY_ALIASES.flatMap(([name, alias]) =>
    text.includes(alias)
      ? [{ name, level: "city" as const, status: "explicit" as const }]
      : [],
  );
  const districts = DISTRICT_HINTS.flatMap((name) =>
    text.includes(name)
      ? [{ name, level: "district" as const, status: "explicit" as const }]
      : [],
  );
  const businessAreas = BUSINESS_ANCHORS.flatMap((name) =>
    text.includes(name)
      ? [{ name, level: "business_area" as const, status: "explicit" as const }]
      : [],
  );
  return unique([...cities, ...districts, ...businessAreas], (item) => item.name);
}

function constraintsFromText(text: string): SpatialConstraint[] {
  const constraints: SpatialConstraint[] = [];
  const distance = Number(text.match(/(?:约|距离)?\s*(\d{2,5})\s*米/)?.[1] ?? 0);
  const direction = text.match(/(东北|西北|东南|西南|东侧|西侧|南侧|北侧|以东|以西|以南|以北)/)?.[1];
  if (distance) constraints.push({ kind: "distance", value: `${distance}米`, distanceMeters: distance });
  if (direction) constraints.push({ kind: "direction", value: direction, direction });
  if (/内|里面|园区内|校内/.test(text)) constraints.push({ kind: "within", value: "内部/包含" });
  const address = text.match(/[\u4e00-\u9fff]{2,12}(?:路|街|巷|大道)\d*(?:号)?/)?.[0];
  if (address) constraints.push({ kind: "address", value: address });
  return constraints;
}

export function relationsForIntent(intent: SpatialIntent): RelationEvidence[] {
  const relations: RelationEvidence[] = intent.anchors.map((anchor) => ({
    predicate: anchor.relation,
    value: anchor.name,
    confidence: 0.9,
  }));
  intent.constraints.forEach((constraint) => {
    if (constraint.kind === "direction") relations.push({ predicate: "DIRECTIONAL", value: constraint.value, confidence: 0.9 });
    if (constraint.kind === "within") relations.push({ predicate: "WITHIN", value: constraint.value, confidence: 0.8 });
    if (constraint.kind === "address") relations.push({ predicate: "ADDRESS_MATCH", value: constraint.value, confidence: 0.85 });
  });
  return relations.length ? relations : [{ predicate: "UNKNOWN", value: "未检测到可验证空间关系", confidence: 0.4 }];
}

function stripAdminPrefix(value: string) {
  let result = value.trim();
  for (const [, alias] of CITY_ALIASES) result = result.replace(new RegExp(`^${alias}(?:市)?`), "");
  for (const district of DISTRICT_HINTS) result = result.replace(new RegExp(`^${district}`), "");
  return result.replace(/^(?:我在|在|请帮我找|帮我找|找)/, "").trim();
}

function targetFrom(value: string): TargetEntity | null {
  const name = value.trim().replace(/^(?:的|有|找)/, "").trim();
  if (name.length < 2) return null;
  const branchQualifier = name.match(/[（(]([^（）()]{2,30})[）)]/)?.[1]?.trim();
  const brand = name.replace(/[（(].*[）)]/, "").trim();
  return { name, brand: brand || name, ...(branchQualifier ? { branchQualifier } : {}) };
}

function anchorTarget(anchorName: string, targetName: string, adminHints: AdministrativeHint[], constraints: SpatialConstraint[]): SpatialIntent {
  const distance = constraints.find((item) => item.kind === "distance")?.distanceMeters;
  const direction = constraints.find((item) => item.kind === "direction")?.direction;
  const anchor: SpatialAnchor = {
    name: anchorName.trim(),
    relation: direction ? "DIRECTIONAL" : "NEAR",
    ...(distance ? { distanceMeters: distance } : {}),
    ...(direction ? { direction } : {}),
  };
  const target = targetFrom(targetName);
  const isDirectionalRange = Boolean(direction && distance);
  return {
    type: target ? (direction ? "RELATIONAL" : "ANCHOR_TARGET") : isDirectionalRange ? "RELATIONAL" : "AMBIGUOUS",
    target,
    // Keep an incomplete anchor as evidence. The graph can then decline safely
    // instead of mistaking its text for a nationwide target-name query.
    anchors: [anchor],
    adminHints,
    constraints,
    queryPlan: target
      ? [
          { stage: "anchor", query: anchor.name, region: adminHints.find((item) => item.level === "city")?.name ?? null, reason: "先验证参照地标" },
          { stage: "around", query: target.name, region: adminHints.find((item) => item.level === "city")?.name ?? null, radiusMeters: distance ? Math.max(300, Math.min(10_000, distance * 2)) : 3_000, reason: "在参照地标附近检索目标实体" },
        ]
      : [{ stage: "anchor", query: anchor.name, region: adminHints.find((item) => item.level === "city")?.name ?? null, reason: isDirectionalRange ? "验证空间关系的参照地标" : "参照地标缺少待检索目标" }],
    needsClarification: !target && !isDirectionalRange,
  };
}

export function planWithRules(text: string): { intent: SpatialIntent; relations: RelationEvidence[] } {
  const cleaned = text.trim();
  const adminHints = administrativeHints(cleaned);
  const constraints = constraintsFromText(cleaned);
  const directionalRange = cleaned.match(/^\s*(.{2,80}?)(?:的)?(?:东北|西北|东南|西南|东侧|西侧|南侧|北侧|以东|以西|以南|以北)(?:约|距离)?\s*\d{2,5}\s*米\s*$/);
  if (directionalRange) {
    const intent = anchorTarget(directionalRange[1], "", adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const incompleteNearby = cleaned.match(/^\s*(.{2,80}?)(?:附近|靠近|旁边|周边|邻近)(?:的)?\s*$/);
  if (incompleteNearby) {
    const intent = anchorTarget(incompleteNearby[1], "", adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const nearby = cleaned.match(/^\s*(.{2,80}?)(?:附近|靠近|旁边|周边|邻近)(?:的)?\s*(.{2,40}?)\s*[。；，,]?\s*$/);
  if (nearby) {
    const intent = anchorTarget(nearby[1], nearby[2], adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const find = cleaned.match(/^\s*(?:我)?(?:在)?(.{2,40}?)(?:附近)?(?:找|寻找|查找|想找)(.{2,40})\s*$/);
  if (find) {
    const intent = anchorTarget(find[1], find[2], adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const withoutAdmin = stripAdminPrefix(cleaned);
  const compactAnchor = BUSINESS_ANCHORS.find((anchor) => withoutAdmin.startsWith(anchor) && withoutAdmin.length > anchor.length + 1);
  if (compactAnchor) {
    const intent = anchorTarget(compactAnchor, withoutAdmin.slice(compactAnchor.length), adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const possessive = withoutAdmin.match(/^(.{2,30}?)的(.{2,40})$/);
  if (possessive && /(?:大学|公园|大厦|中心|广场|站|口)$/.test(possessive[1])) {
    const intent = anchorTarget(possessive[1], possessive[2], adminHints, constraints);
    return { intent, relations: relationsForIntent(intent) };
  }

  const target = targetFrom(withoutAdmin);
  const city = adminHints.find((item) => item.level === "city")?.name ?? null;
  const intent: SpatialIntent = {
    type: target ? "DIRECT_POI" : "AMBIGUOUS",
    target,
    anchors: [],
    adminHints,
    constraints,
    queryPlan: target ? [{ stage: "target", query: target.name, region: city, reason: "直接名称检索" }] : [],
    needsClarification: !target,
  };
  return { intent, relations: relationsForIntent(intent) };
}

export function mergeIntent(ruleIntent: SpatialIntent, enrichment: Partial<SpatialIntent> | null): SpatialIntent {
  if (!enrichment) return ruleIntent;
  const target = ruleIntent.target ?? enrichment.target ?? null;
  const anchors = ruleIntent.anchors.length ? ruleIntent.anchors : enrichment.anchors ?? [];
  const adminHints = unique([...ruleIntent.adminHints, ...(enrichment.adminHints ?? [])], (item) => item.name);
  const constraints = unique([...ruleIntent.constraints, ...(enrichment.constraints ?? [])], (item) => `${item.kind}:${item.value}`);
  const type = anchors.length && target ? "ANCHOR_TARGET" : target ? ruleIntent.type : "AMBIGUOUS";
  const city = adminHints.find((item) => item.level === "city")?.name ?? null;
  const queryPlan = anchors.length && target
    ? [
        { stage: "anchor" as const, query: anchors[0].name, region: city, reason: "验证语义规划器提出的参照地标" },
        { stage: "around" as const, query: target.name, region: city, radiusMeters: anchors[0].distanceMeters ? Math.max(300, Math.min(10_000, anchors[0].distanceMeters * 2)) : 3_000, reason: "围绕已验证锚点检索目标" },
      ]
    : target
      ? [{ stage: "target" as const, query: target.name, region: city, reason: "结构化目标检索" }]
      : [];
  return { type, target, anchors, adminHints, constraints, queryPlan, needsClarification: ruleIntent.needsClarification || !target || enrichment.needsClarification === true };
}

export function intentSummary(intent: SpatialIntent) {
  const target = intent.target?.name ?? "未识别目标";
  const anchor = intent.anchors[0]?.name;
  const city = intent.adminHints.find((item) => item.level === "city")?.name;
  return [
    `意图：${intent.type}`,
    `目标：${target}`,
    ...(anchor ? [`参照：${anchor}`] : []),
    ...(city ? [`城市提示：${city}`] : []),
  ];
}
