"use client";

import * as maplibregl from "maplibre-gl";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { ResolveResponse } from "@/lib/agent/types";

const emptyCollection = {
  type: "FeatureCollection",
  features: [],
} as const;

const contextLines = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { class: "arterial" },
      geometry: {
        type: "LineString",
        coordinates: [
          [116.292, 39.994],
          [116.299, 39.9934],
          [116.3055, 39.992],
          [116.314, 39.988],
          [116.323, 39.981],
        ],
      },
    },
    {
      type: "Feature",
      properties: { class: "road" },
      geometry: {
        type: "LineString",
        coordinates: [
          [116.304, 40.003],
          [116.305, 39.998],
          [116.3055, 39.992],
          [116.306, 39.985],
        ],
      },
    },
  ],
};

function tiandituTiles(layer: "vec" | "cva", key: string) {
  return Array.from(
    { length: 8 },
    (_, index) =>
      `https://t${index}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${key}`,
  );
}

function createStyle(): StyleSpecification {
  const key = process.env.NEXT_PUBLIC_TIANDITU_KEY?.trim();
  if (!key) {
    return {
      version: 8,
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#07131f" },
        },
      ],
    };
  }
  return {
    version: 8,
    sources: {
      tianditu: {
        type: "raster",
        tiles: tiandituTiles("vec", key),
        tileSize: 256,
        attribution: "天地图",
      },
      tiandituLabels: {
        type: "raster",
        tiles: tiandituTiles("cva", key),
        tileSize: 256,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#07131f" },
      },
      {
        id: "tianditu",
        type: "raster",
        source: "tianditu",
        paint: {
          "raster-saturation": -0.7,
          "raster-brightness-max": 0.55,
        },
      },
      {
        id: "tianditu-labels",
        type: "raster",
        source: "tiandituLabels",
        paint: { "raster-opacity": 0.8 },
      },
    ],
  };
}

function getSource(map: MapLibreMap, id: string) {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function updateMap(map: MapLibreMap, result: ResolveResponse) {
  const candidates = {
    type: "FeatureCollection",
    features: result.candidates.map((candidate, index) => ({
      type: "Feature",
      properties: {
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
        selected:
          candidate.id === result.selectedCandidate?.id ||
          (result.decision === "RESOLVED" && index === 0),
      },
      geometry: { type: "Point", coordinates: candidate.location },
    })),
  };

  getSource(map, "candidates")?.setData(candidates as never);
  getSource(map, "s2-grid")?.setData(
    (result.spatial?.geojson ?? emptyCollection) as never,
  );

  const points = result.candidates.map((candidate) => candidate.location);
  if (result.selectedCandidate) points.push(result.selectedCandidate.location);
  if (!points.length) return;

  const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
  points.slice(1).forEach((point) => bounds.extend(point));
  result.spatial?.geojson.features.forEach((feature) => {
    feature.geometry.coordinates[0].forEach((point) =>
      bounds.extend(point as [number, number]),
    );
  });
  map.fitBounds(bounds, {
    padding: 72,
    maxZoom: 16.5,
    duration: 700,
  });
}

export function SpatialMap({ result }: { result: ResolveResponse }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const resultRef = useRef(result);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createStyle(),
      center: [116.3055, 39.992],
      zoom: 14.3,
      attributionControl: false,
      pitch: 12,
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      map.addSource("context", { type: "geojson", data: contextLines as never });
      map.addLayer({
        id: "context-halo",
        type: "line",
        source: "context",
        paint: {
          "line-color": "#02070d",
          "line-width": 7,
          "line-opacity": 0.72,
        },
      });
      map.addLayer({
        id: "context-road",
        type: "line",
        source: "context",
        paint: {
          "line-color": "#234158",
          "line-width": 2.2,
          "line-opacity": 0.95,
        },
      });

      map.addSource("s2-grid", {
        type: "geojson",
        data: emptyCollection as never,
      });
      map.addLayer({
        id: "s2-fill",
        type: "fill",
        source: "s2-grid",
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "selected"], true],
            "#5eead4",
            "#22d3ee",
          ],
          "fill-opacity": [
            "case",
            ["==", ["get", "selected"], true],
            0.24,
            0.1,
          ],
        },
      });
      map.addLayer({
        id: "s2-line",
        type: "line",
        source: "s2-grid",
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "selected"], true],
            "#99f6e4",
            "#22d3ee",
          ],
          "line-width": [
            "case",
            ["==", ["get", "selected"], true],
            2.2,
            1.1,
          ],
          "line-opacity": 0.9,
        },
      });

      map.addSource("candidates", {
        type: "geojson",
        data: emptyCollection as never,
      });
      map.addLayer({
        id: "candidate-halo",
        type: "circle",
        source: "candidates",
        paint: {
          "circle-radius": 11,
          "circle-color": "#02070d",
          "circle-opacity": 0.72,
        },
      });
      map.addLayer({
        id: "candidate-points",
        type: "circle",
        source: "candidates",
        paint: {
          "circle-radius": [
            "case",
            ["==", ["get", "selected"], true],
            6.5,
            4.5,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "selected"], true],
            "#f8fafc",
            "#22d3ee",
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "selected"], true],
            "#14b8a6",
            "#0e7490",
          ],
          "circle-stroke-width": 2,
        },
      });
      updateMap(map, resultRef.current);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (mapRef.current?.isStyleLoaded()) updateMap(mapRef.current, result);
  }, [result]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-[360px] w-full"
      aria-label="候选位置和 S2 网格地图"
    />
  );
}
