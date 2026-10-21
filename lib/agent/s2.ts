import { S2Cell, S2CellId, S2LatLng } from "nodes2ts";
import type { Candidate, Decision, GeoJsonFeatureCollection, S2Representation } from "./types";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function isValidLngLat([lng, lat]: [number, number]) {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

export function buildAdaptiveS2(
  candidate: Candidate | null,
  decision: Decision,
  confidence: number,
  relationCount: number,
): S2Representation | null {
  if (!candidate || decision === "ABSTAIN" || decision === "NEED_CLARIFICATION" || !isValidLngLat(candidate.location)) {
    return null;
  }

  const semanticUncertainty = Number((1 - confidence).toFixed(3));
  const coordinateUncertainty = Math.min(
    0.6,
    (candidate.coordinateAccuracyMeters ?? 15) / 1000,
  );
  const baseGeometryUncertainty =
    decision === "COARSE"
      ? candidate.geometryOrigin === "relation-inference"
        ? 0.28 + coordinateUncertainty
        : 0.52 + coordinateUncertainty
      : 0.08 + coordinateUncertainty;
  const geometricUncertainty = Number(
    clamp(
      baseGeometryUncertainty - Math.min(0.1, relationCount * 0.025),
      0.08,
      0.82,
    ).toFixed(3),
  );
  const combinedUncertainty = Number(
    (semanticUncertainty * 0.64 + geometricUncertainty * 0.36).toFixed(3),
  );
  const level = clamp(20 - Math.round(combinedUncertainty * 12), 13, 20);
  const [lng, lat] = candidate.location;
  const leaf = S2CellId.fromPoint(S2LatLng.fromDegrees(lat, lng).toPoint());
  const center = leaf.parentL(level);
  const neighborBudget =
    decision === "COARSE"
      ? geometricUncertainty >= 0.55
        ? 8
        : geometricUncertainty >= 0.35
          ? 4
          : 2
      : 0;
  const ids = [center, ...center.getAllNeighbors(level).slice(0, neighborBudget)];
  const unique = [...new Map(ids.map((id) => [id.toToken(), id])).values()];
  const features = unique.map((id) => {
    const feature = new S2Cell(id).toGEOJSON() as GeoJsonFeatureCollection["features"][number];
    return {
      ...feature,
      properties: {
        ...feature.properties,
        token: id.toToken(),
        level,
        selected: id.toToken() === center.toToken(),
      },
    };
  });

  return {
    system: "S2",
    level,
    cellIds: unique.map((id) => id.toToken()),
    cellCount: unique.length,
    method: "confidence-geometry-heuristic-v0.2",
    coverageNote:
      decision === "COARSE"
        ? "MVP 使用候选中心及邻居 S2 单元表达支持范围；后续替换为方向扇区和概率覆盖优化。"
        : "使用高置信候选中心所在 S2 单元。",
    semanticUncertainty,
    geometricUncertainty,
    combinedUncertainty,
    geojson: { type: "FeatureCollection", features },
  };
}
