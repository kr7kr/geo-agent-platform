import { normalizeText } from "./planner";
import type {
  Candidate,
  CandidateEvidence,
  CandidateScores,
  EntityType,
  SpatialIntent,
} from "./types";

const CITY_NAMES = ["北京市", "上海市", "天津市", "重庆市", "广州市", "深圳市", "南京市", "武汉市", "成都市", "杭州市"];
const DISTRICT_NAMES = ["海淀区", "朝阳区", "东城区", "西城区", "昌平区", "通州区"];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function orderedSimilarity(left: string, right: string) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const grams = (value: string) => {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
    return result;
  };
  const leftGrams = grams(a);
  const rightGrams = grams(b);
  const overlap = [...leftGrams].filter((item) => rightGrams.has(item)).length;
  return leftGrams.size + rightGrams.size ? (2 * overlap) / (leftGrams.size + rightGrams.size) : 0;
}

function knownCityConflict(candidate: Candidate, intent: SpatialIntent) {
  const requested = intent.adminHints.find((hint) => hint.level === "city")?.name;
  if (!requested) return false;
  const observed = CITY_NAMES.find((city) => candidate.address.includes(city));
  return Boolean(observed && observed !== requested);
}

function knownDistrictConflict(candidate: Candidate, intent: SpatialIntent) {
  const requested = intent.adminHints.find((hint) => hint.level === "district" && hint.status === "explicit")?.name;
  if (!requested) return false;
  const observed = DISTRICT_NAMES.find((district) => candidate.address.includes(district));
  return Boolean(observed && observed !== requested);
}

function textIncludes(address: string, value: string | undefined) {
  return Boolean(value && normalizeText(address).includes(normalizeText(value)));
}

function entityTypeConflict(candidate: Candidate, expected: EntityType) {
  const category = candidate.category;
  if (expected === "university") {
    if (/交通|公交|地铁|停车|道路/.test(category)) return true;
    if (/医疗|餐饮|购物|住宅|酒店/.test(category)) return true;
  }
  if (expected === "hospital" && /交通|公交|地铁|学校|科教/.test(category)) return true;
  if (expected === "station" && /科教|学校|医疗|餐饮/.test(category)) return true;
  return false;
}

export function rankCandidates(candidates: Candidate[], intent: SpatialIntent) {
  const target = intent.target;
  const city = intent.adminHints.find((hint) => hint.level === "city")?.name;
  const district = intent.adminHints.find((hint) => hint.level === "district")?.name;
  const businessArea = intent.adminHints.find((hint) => hint.level === "business_area")?.name;
  const anchor = intent.anchors[0];
  const rejected: CandidateEvidence[] = [];
  const ranked = candidates.flatMap((candidate) => {
    if (!target) {
      rejected.push({ candidateId: candidate.id, verdict: "rejected", reasons: ["没有可验证的目标实体"] });
      return [];
    }
    if (knownCityConflict(candidate, intent)) {
      rejected.push({ candidateId: candidate.id, verdict: "rejected", reasons: [`与城市提示“${city}”冲突`] });
      return [];
    }
    if (knownDistrictConflict(candidate, intent)) {
      rejected.push({ candidateId: candidate.id, verdict: "rejected", reasons: [`与区县提示“${district}”冲突`] });
      return [];
    }
    if (entityTypeConflict(candidate, target.entityType ?? "unknown")) {
      rejected.push({ candidateId: candidate.id, verdict: "rejected", reasons: [`POI 类型“${candidate.category}”与预期实体类型“${target.entityType}”冲突`] });
      return [];
    }
    if (anchor?.distanceMeters && candidate.distanceMeters && candidate.distanceMeters > anchor.distanceMeters * 2.5 + 200) {
      rejected.push({ candidateId: candidate.id, verdict: "rejected", reasons: ["超出显式空间关系的允许距离"] });
      return [];
    }

    const candidateName = normalizeText(candidate.name);
    const targetName = normalizeText(target.name);
    const brandName = normalizeText(target.brand ?? target.name);
    const fullNameExact = candidateName === targetName || targetName.includes(candidateName) || candidateName.includes(targetName);
    const brandExact = Boolean(brandName && candidateName.includes(brandName));
    const nameScore = fullNameExact ? 1 : Math.max(brandExact ? 0.82 : 0, orderedSimilarity(candidate.name, target.name));
    const branchScore = target.branchQualifier
      ? (normalizeText(candidate.name).includes(normalizeText(target.branchQualifier)) || textIncludes(candidate.address, target.branchQualifier) ? 1 : 0)
      : 0;
    const entityLinkScore = target.entityLinkScore ?? 0.5;
    const cityScore = city ? (textIncludes(candidate.address, city.replace(/市$/, "")) ? 1 : 0) : 0.45;
    const districtScore = district ? (textIncludes(candidate.address, district) ? 1 : 0) : 0.45;
    const businessScore = businessArea ? (textIncludes(candidate.address, businessArea) || normalizeText(candidate.name).includes(normalizeText(businessArea)) ? 1 : 0) : 0.45;
    const adminScore = clamp(cityScore * 0.55 + districtScore * 0.3 + businessScore * 0.15);
    const spatialScore = anchor
      ? candidate.distanceMeters === undefined
        ? 0.35
        : clamp(1 - candidate.distanceMeters / 3_000)
      : 0.45;
    const sourceScore = clamp(1 - candidate.sourceRank / 12);
    const retrievalScore = clamp(nameScore * 0.55 + sourceScore * 0.2 + spatialScore * 0.25);
    const decisionConfidence = Number(clamp(
      0.08 + nameScore * 0.4 + branchScore * 0.18 + adminScore * 0.14 + spatialScore * 0.14 + sourceScore * 0.06,
    ).toFixed(3));
    const scores: CandidateScores = {
      retrievalScore: Number(retrievalScore.toFixed(3)),
      entityLinkScore: Number(entityLinkScore.toFixed(3)),
      nameScore: Number(nameScore.toFixed(3)),
      branchScore: Number(branchScore.toFixed(3)),
      adminScore: Number(adminScore.toFixed(3)),
      spatialScore: Number(spatialScore.toFixed(3)),
      sourceScore: Number(sourceScore.toFixed(3)),
      decisionConfidence,
    };
    const reasons = [
      fullNameExact ? "完整名称或分店名称匹配" : brandExact ? "品牌名称匹配" : "名称为弱相似匹配",
      ...(target.originalMention ? [`简称“${target.originalMention}”已链接至“${target.name}”`] : []),
      ...(target.branchQualifier ? [branchScore ? "分店限定词匹配" : "分店限定词未验证"] : []),
      ...(city ? [cityScore ? `城市“${city}”一致` : `城市“${city}”未验证`] : []),
      ...(district ? [districtScore ? `区县“${district}”一致` : `区县“${district}”未验证`] : []),
      ...(businessArea ? [businessScore ? `商圈“${businessArea}”一致` : `商圈“${businessArea}”未验证`] : []),
      ...(anchor && candidate.distanceMeters !== undefined ? [`距参照点 ${candidate.distanceMeters} 米`] : []),
      `高德原始顺位 #${candidate.sourceRank + 1}`,
    ];
    return [{
      ...candidate,
      score: decisionConfidence,
      scores,
      evidence: [...candidate.evidence, ...reasons],
      _evidence: { candidateId: candidate.id, verdict: "kept" as const, reasons },
    }];
  }).sort((left, right) => right.score - left.score || left.sourceRank - right.sourceRank);
  return {
    candidates: ranked.map(({ _evidence, ...candidate }) => {
      void _evidence;
      return candidate;
    }),
    evidence: [...ranked.map((item) => item._evidence), ...rejected],
  };
}

export function isExactVerified(candidate: Candidate, intent: SpatialIntent) {
  const scores = candidate.scores;
  if (!scores || !intent.target) return false;
  const targetName = normalizeText(intent.target.name);
  const candidateName = normalizeText(candidate.name);
  const fullNameExact = targetName.includes(candidateName) || candidateName.includes(targetName);
  // A bare brand can be the only page of provider results because of
  // pagination or provider bias. It is not a verified branch.
  const specificName = Boolean(intent.target.branchQualifier) || targetName === candidateName ||
    Boolean(intent.target.entityLinkScore && intent.target.entityLinkScore >= 0.95 && candidateName.includes(targetName));
  const hasContext = scores.adminScore >= 0.45 || scores.spatialScore >= 0.7;
  return specificName && fullNameExact && hasContext && scores.decisionConfidence >= 0.78;
}
