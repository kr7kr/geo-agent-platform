import type { Candidate } from "./types";

interface CatalogRecord {
  id: string;
  name: string;
  aliases: string[];
  address: string;
  category: string;
  location: [number, number];
}

const DEMO_CATALOG: CatalogRecord[] = [
  {
    id: "demo-bj-pku-east-gate",
    name: "北京大学东门",
    aliases: ["北大东门", "北京大学东侧门"],
    address: "北京市海淀区成府路",
    category: "科教文化服务·高等院校",
    location: [116.3055, 39.992],
  },
  {
    id: "demo-bj-wangjing-soho",
    name: "望京SOHO",
    aliases: ["望京soho", "望京搜候"],
    address: "北京市朝阳区阜通东大街1号",
    category: "商务住宅·楼宇",
    location: [116.4824, 39.99835],
  },
  {
    id: "demo-bj-haidian-huangzhuang",
    name: "海淀黄庄地铁站",
    aliases: ["海淀黄庄站", "海淀黄庄"],
    address: "北京市海淀区中关村大街",
    category: "交通设施服务·地铁站",
    location: [116.317564, 39.975996],
  },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s·（）()\-]/g, "");
}

function bigramSimilarity(a: string, b: string) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 0.94;
  const grams = (value: string) => {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) {
      result.add(value.slice(index, index + 2));
    }
    return result;
  };
  const x = grams(left);
  const y = grams(right);
  const intersection = [...x].filter((gram) => y.has(gram)).length;
  const union = new Set([...x, ...y]).size;
  return union ? intersection / union : 0;
}

export function searchDemoCatalog(text: string, mentions: string[]): Candidate[] {
  const query = normalize(text);
  return DEMO_CATALOG.map((record, sourceRank) => {
    const variants = [record.name, ...record.aliases];
    const direct = variants.some((variant) => query.includes(normalize(variant)));
    const similarity = Math.max(
      ...variants.flatMap((variant) => [
        bigramSimilarity(text, variant),
        ...mentions.map((mention) => bigramSimilarity(mention, variant)),
      ]),
    );
    const score = direct ? 0.92 : Math.min(0.82, similarity * 0.86);
    return {
      id: record.id,
      name: record.name,
      address: record.address,
      category: record.category,
      source: "demo-index" as const,
      sourceRank,
      location: record.location,
      crs: "WGS84" as const,
      score,
      evidence: direct
        ? ["名称或别名直接命中", "本地演示索引"]
        : ["字符二元组相似", "本地演示索引"],
    };
  })
    .filter((candidate) => candidate.score >= 0.24)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

