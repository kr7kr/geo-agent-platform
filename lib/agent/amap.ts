import type { Candidate } from "./types";

interface AmapPoi {
  id?: string;
  name?: string;
  address?: string | string[];
  type?: string;
  location?: string;
  pname?: string;
  cityname?: string;
  adname?: string;
  distance?: string | number;
}

interface AmapResponse {
  status?: string;
  info?: string;
  pois?: AmapPoi[];
}

const PI = Math.PI;
const AXIS = 6378245;
const OFFSET = 0.006693421622965943;

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function isValidCoordinate(lng: number, lat: number) {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

function transformLat(lng: number, lat: number) {
  let value = -100 + 2 * lng + 3 * lat + 0.2 * lat * lat + 0.1 * lng * lat;
  value += 0.2 * Math.sqrt(Math.abs(lng));
  value += ((20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2) / 3;
  value += ((20 * Math.sin(lat * PI) + 40 * Math.sin((lat / 3) * PI)) * 2) / 3;
  value += ((160 * Math.sin((lat / 12) * PI) + 320 * Math.sin((lat * PI) / 30)) * 2) / 3;
  return value;
}

function transformLng(lng: number, lat: number) {
  let value = 300 + lng + 2 * lat + 0.1 * lng * lng + 0.1 * lng * lat;
  value += 0.1 * Math.sqrt(Math.abs(lng));
  value += ((20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2) / 3;
  value += ((20 * Math.sin(lng * PI) + 40 * Math.sin((lng / 3) * PI)) * 2) / 3;
  value += ((150 * Math.sin((lng / 12) * PI) + 300 * Math.sin((lng / 30) * PI)) * 2) / 3;
  return value;
}

function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - OFFSET * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((AXIS * (1 - OFFSET)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return [Number((lng * 2 - (lng + dLng)).toFixed(6)), Number((lat * 2 - (lat + dLat)).toFixed(6))];
}

function distanceMeters(
  [lngA, latA]: [number, number],
  [lngB, latB]: [number, number],
) {
  const radians = Math.PI / 180;
  const dLat = (latB - latA) * radians;
  const dLng = (lngB - lngA) * radians;
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * radians) * Math.cos(latB * radians) * Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)));
}

function toCandidate(
  poi: AmapPoi,
  sourceRank: number,
  extraEvidence: string[] = [],
  center?: [number, number],
  retrieval?: Candidate["retrieval"],
): Candidate[] {
  if (!poi.location || !poi.name) return [];
  const [gcjLng, gcjLat] = poi.location.split(",").map(Number);
  if (!isValidCoordinate(gcjLng, gcjLat)) return [];
  const location = gcj02ToWgs84(gcjLng, gcjLat);
  if (!isValidCoordinate(location[0], location[1])) return [];
  const address = Array.isArray(poi.address) ? poi.address.join("") : poi.address ?? "";
  const reportedDistance = Number(poi.distance);
  const computedDistance = center ? distanceMeters(center, location) : null;
  const nearbyEvidence = Number.isFinite(reportedDistance)
    ? `高德周边检索距离 ${Math.round(reportedDistance)} 米`
    : computedDistance !== null
      ? `相对参照点直线距离约 ${computedDistance} 米`
      : null;
  return [{
    id: poi.id || `amap-${sourceRank}`,
    name: poi.name,
    address: [poi.pname, poi.cityname, poi.adname, address].filter(Boolean).join(""),
    category: poi.type ?? "未分类",
    source: "amap" as const,
    sourceRank,
    ...(retrieval ? { retrieval } : {}),
    location,
    originalLocation: [gcjLng, gcjLat] as [number, number],
    crs: "WGS84" as const,
    sourceCrs: "GCJ-02" as const,
    coordinateAccuracyMeters: 10,
    ...(Number.isFinite(reportedDistance)
      ? { distanceMeters: Math.round(reportedDistance) }
      : computedDistance !== null
        ? { distanceMeters: computedDistance }
        : {}),
    geometryOrigin: "source-poi" as const,
    score: Number(Math.max(0.28, 0.58 - sourceRank * 0.02).toFixed(3)),
    evidence: [
      "高德 POI 2.0 候选召回",
      "服务排序不是校准置信度",
      "原始坐标 GCJ-02，已标准化为 WGS84（约米级误差）",
      ...extraEvidence,
      ...(nearbyEvidence ? [nearbyEvidence] : []),
    ],
  }];
}

export async function searchAmapPois(
  query: string,
  region: string | null,
  key: string,
): Promise<Candidate[]> {
  const url = new URL("https://restapi.amap.com/v5/place/text");
  url.searchParams.set("key", key);
  url.searchParams.set("keywords", query.slice(0, 80));
  url.searchParams.set("page_size", "10");
  url.searchParams.set("page_num", "1");
  if (region) {
    url.searchParams.set("region", region);
    url.searchParams.set("city_limit", "true");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`AMAP_HTTP_${response.status}`);
  const payload = (await response.json()) as AmapResponse;
  if (payload.status !== "1") throw new Error(`AMAP_${payload.info ?? "UNKNOWN"}`);

  return (payload.pois ?? []).flatMap((poi, sourceRank) =>
    toCandidate(
      poi,
      sourceRank,
      [`文本检索关键词：“${query.slice(0, 80)}”`, `检索区域：${region ?? "未限定"}`],
      undefined,
      { operation: "text", query: query.slice(0, 80), region, sourceRank },
    ));
}

export async function searchAmapNearbyPois(
  query: string,
  anchor: Candidate,
  key: string,
  radiusMeters = 3_000,
): Promise<Candidate[]> {
  const [gcjLng, gcjLat] = anchor.originalLocation ?? anchor.location;
  if (!isValidCoordinate(gcjLng, gcjLat)) return [];
  const url = new URL("https://restapi.amap.com/v5/place/around");
  url.searchParams.set("key", key);
  url.searchParams.set("keywords", query.slice(0, 80));
  url.searchParams.set("location", `${gcjLng.toFixed(6)},${gcjLat.toFixed(6)}`);
  url.searchParams.set("radius", String(Math.min(50_000, Math.max(100, radiusMeters))));
  url.searchParams.set("page_size", "10");
  url.searchParams.set("page_num", "1");
  url.searchParams.set("sortrule", "distance");

  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`AMAP_HTTP_${response.status}`);
  const payload = (await response.json()) as AmapResponse;
  if (payload.status !== "1") throw new Error(`AMAP_${payload.info ?? "UNKNOWN"}`);
  return (payload.pois ?? []).flatMap((poi, sourceRank) =>
    toCandidate(
      poi,
      sourceRank,
      [`以“${anchor.name}”为参照点进行周边检索`, `周边检索关键词：“${query.slice(0, 80)}”`, `检索半径：${radiusMeters} 米`],
      anchor.location,
      {
        operation: "around",
        query: query.slice(0, 80),
        radiusMeters,
        sourceRank,
        ...(Number.isFinite(Number(poi.distance)) ? { rawDistanceMeters: Math.round(Number(poi.distance)) } : {}),
      },
    ),
  );
}
