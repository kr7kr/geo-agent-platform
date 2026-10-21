import type { EntityType, KnowledgeGraphHit, KnowledgeRetrieval } from "./types";

interface GraphNode {
  id: string;
  canonicalName: string;
  aliases: string[];
  entityType: EntityType;
  city?: string;
  district?: string;
  tags?: string[];
}

interface GraphEdge {
  from: string;
  predicate: "LOCATED_IN" | "HAS_BRANCH_AT" | "RELATED_TO";
  to: string;
  note: string;
}

// The seed is deliberately compact and auditable. It has no coordinates: a
// graph hit is only a retrieval/query-expansion prior, and must still be
// corroborated by an external POI tool before a spatial decision is made.
const NODES: GraphNode[] = [
  { id: "university:pku", canonicalName: "北京大学", aliases: ["北大", "燕园"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:thu", canonicalName: "清华大学", aliases: ["清华", "清华园"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:buAA", canonicalName: "北京航空航天大学", aliases: ["北航", "北京航大"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:ustb", canonicalName: "北京科技大学", aliases: ["北科大", "北科"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:bit", canonicalName: "北京理工大学", aliases: ["北理工", "北理"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:cupb", canonicalName: "中国石油大学（北京）", aliases: ["石大北京", "中石大北京"], entityType: "university", city: "北京市", district: "昌平区", tags: ["高校", "大学"] },
  { id: "university:cumtb", canonicalName: "中国矿业大学（北京）", aliases: ["北矿大", "北京矿大", "中矿大北京"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:cugb-beijing", canonicalName: "中国地质大学（北京）", aliases: ["北地大", "地大北京", "中地大北京"], entityType: "university", city: "北京市", district: "海淀区", tags: ["高校", "大学"] },
  { id: "university:cugb-wuhan", canonicalName: "中国地质大学（武汉）", aliases: ["武地大", "地大武汉", "中地大武汉"], entityType: "university", city: "武汉市", district: "洪山区", tags: ["高校", "大学"] },
  { id: "university:aust", canonicalName: "安徽理工大学", aliases: ["安理", "安理大"], entityType: "university", city: "淮南市", district: "田家庵区", tags: ["高校", "大学"] },
  { id: "university:xjtu", canonicalName: "西安交通大学", aliases: ["西安交大", "西交", "交大西安"], entityType: "university", city: "西安市", district: "碑林区", tags: ["高校", "大学"] },
  { id: "commercial:wudaokou", canonicalName: "五道口", aliases: ["五道口商圈"], entityType: "commercial_area", city: "北京市", district: "海淀区", tags: ["商圈", "地标"] },
  { id: "landmark:dongyuan-building", canonicalName: "东源大厦", aliases: ["五道口东源大厦"], entityType: "landmark", city: "北京市", district: "海淀区", tags: ["楼宇", "五道口"] },
  { id: "poi:guanshi-wudaokou", canonicalName: "管氏翅吧（五道口东源大厦店）", aliases: ["五道口管氏翅吧", "管氏翅吧东源大厦店"], entityType: "organization", city: "北京市", district: "海淀区", tags: ["餐饮", "门店", "五道口"] },
  { id: "landmark:wangjing-soho", canonicalName: "望京SOHO", aliases: ["望京soho"], entityType: "landmark", city: "北京市", district: "朝阳区", tags: ["楼宇", "商务区"] },
];

const EDGES: GraphEdge[] = [
  { from: "university:pku", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:thu", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:buAA", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:ustb", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:cumtb", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:cugb-beijing", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "university:cugb-wuhan", predicate: "LOCATED_IN", to: "武汉市洪山区", note: "图谱行政区关系" },
  { from: "university:aust", predicate: "LOCATED_IN", to: "淮南市田家庵区", note: "图谱行政区关系" },
  { from: "university:xjtu", predicate: "LOCATED_IN", to: "西安市碑林区", note: "图谱行政区关系" },
  { from: "commercial:wudaokou", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "landmark:dongyuan-building", predicate: "LOCATED_IN", to: "北京市海淀区", note: "图谱行政区关系" },
  { from: "poi:guanshi-wudaokou", predicate: "HAS_BRANCH_AT", to: "东源大厦", note: "图谱门店限定词" },
  { from: "landmark:wangjing-soho", predicate: "LOCATED_IN", to: "北京市朝阳区", note: "图谱行政区关系" },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s()（）,，.。;；:：'"“”‘’、/\\_-]/g, "");
}

function characterOverlap(left: string, right: string) {
  if (!left || !right) return 0;
  const chars = new Set(left);
  return [...new Set(right)].filter((character) => chars.has(character)).length / new Set(right).size;
}

function relationsFor(node: GraphNode) {
  return EDGES
    .filter((edge) => edge.from === node.id)
    .map((edge) => {
      const predicate = edge.predicate === "LOCATED_IN"
        ? "位于"
        : edge.predicate === "HAS_BRANCH_AT"
          ? "门店限定于"
          : "关联";
      return `图谱关系：${node.canonicalName}${predicate}${edge.to}（${edge.note}）`;
    });
}

function scoreNode(node: GraphNode, query: string) {
  const normalizedQuery = normalize(query);
  const terms = [node.canonicalName, ...node.aliases, ...(node.tags ?? []), node.city ?? "", node.district ?? ""]
    .filter(Boolean);
  const matchedTerms = terms.filter((term) => {
    const normalizedTerm = normalize(term);
    return normalizedTerm.length >= 2 && normalizedQuery.includes(normalizedTerm);
  });
  const directCanonical = normalizedQuery.includes(normalize(node.canonicalName));
  const directAlias = node.aliases.some((alias) => normalizedQuery.includes(normalize(alias)));
  const lexical = Math.max(...terms.map((term) => characterOverlap(normalizedQuery, normalize(term))), 0);
  const score = directCanonical ? 1 : directAlias ? 0.98 : matchedTerms.length ? Math.max(0.46, lexical) : lexical * 0.36;
  return { score: Math.min(1, score), matchedTerms };
}

export function retrieveKnowledge(query: string, limit = 6): KnowledgeRetrieval {
  const hits = NODES
    .map((node) => ({ node, ...scoreNode(node, query) }))
    .filter((item) => item.score >= 0.42 && item.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || left.node.canonicalName.localeCompare(right.node.canonicalName, "zh-CN"))
    .slice(0, limit)
    .map<KnowledgeGraphHit>(({ node, score, matchedTerms }) => ({
      nodeId: node.id,
      canonicalName: node.canonicalName,
      aliases: node.aliases,
      entityType: node.entityType,
      ...(node.city ? { city: node.city } : {}),
      ...(node.district ? { district: node.district } : {}),
      score,
      matchedTerms,
      facts: [
        `图谱实体：${node.canonicalName}`,
        `实体类型：${node.entityType}`,
        ...(node.city ? [`图谱城市提示：${node.city}`] : []),
        ...(node.district ? [`图谱区县提示：${node.district}`] : []),
      ],
      relations: relationsFor(node),
      source: "seed-graph",
    }));

  return {
    mode: "local-graph-rag",
    query,
    corpusSize: NODES.length,
    hits,
    note: hits.length
      ? "图谱命中只用于实体消歧、查询扩展和行政区线索；最终结果仍需 POI 证据验证。"
      : "未命中足够强的图谱线索，保留原始文本并交由后续工具检索。",
  };
}

export const KNOWLEDGE_GRAPH_SIZE = NODES.length;
