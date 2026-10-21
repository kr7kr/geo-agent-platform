import type { EntityType } from "./types";

export interface EntityAliasRecord {
  canonicalName: string;
  aliases: string[];
  entityType: EntityType;
  city?: string;
  district?: string;
}

// This is deliberately data, not branching logic. It is a seed registry that
// can grow from audited aliases without changing the linking algorithm.
export const ENTITY_ALIAS_REGISTRY: EntityAliasRecord[] = [
  { canonicalName: "北京大学", aliases: ["北大", "燕园"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "清华大学", aliases: ["清华", "清华园"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "北京航空航天大学", aliases: ["北航", "北京航大"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "北京科技大学", aliases: ["北科大", "北科"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "北京理工大学", aliases: ["北理工", "北理"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "北京邮电大学", aliases: ["北邮"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "北京师范大学", aliases: ["北师大"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "中国人民大学", aliases: ["人大", "中国人大"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "中国矿业大学（北京）", aliases: ["北矿大", "北京矿大", "中矿大北京"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "中国矿业大学", aliases: ["徐州矿大", "中矿大徐州"], entityType: "university", city: "徐州市" },
  { canonicalName: "中国地质大学（北京）", aliases: ["北地大", "地大北京", "中地大北京", "地大"], entityType: "university", city: "北京市", district: "海淀区" },
  { canonicalName: "中国地质大学（武汉）", aliases: ["武地大", "地大武汉", "中地大武汉", "地大"], entityType: "university", city: "武汉市" },
  { canonicalName: "华中科技大学", aliases: ["华科", "华中大"], entityType: "university", city: "武汉市" },
  { canonicalName: "西安电子科技大学", aliases: ["西电"], entityType: "university", city: "西安市" },
  { canonicalName: "同济大学", aliases: ["同济"], entityType: "university", city: "上海市" },
];
