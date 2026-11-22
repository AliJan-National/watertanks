/**
 * Exposure analysis: which buildings and roads are inside the modelled inundation, and
 * how deep/soon the water reaches them.
 *
 * IMPORTANT WORDING RULE
 * Everything here reports "modelled inundation", never damage. A building whose footprint
 * intersects the modelled extent is *exposed to modelled flooding*; whether it would suffer
 * damage depends on construction, openings, thresholds and the DEM error — none of which
 * this screening tool knows. The UI must keep that distinction.
 */

import type {
  Building,
  BuildingImpact,
  Grid,
  RoadImpact,
  SimulationResult,
} from "./types";
import type { OsmBuilding, OsmRoad } from "../providers/basemaps";

export interface ExposureResult {
  buildings: BuildingImpact[];
  roads: RoadImpact[];
  totals: {
    buildingCount: number;
    buildingFootprintAreaM2: number;
    buildingByBand: { low: number; moderate: number; high: number };
    roadAffectedM: number;
    roadTotalM: number;
    roadByClass: Record<string, number>;
  };
  notes: string[];
}

/** Samples the result grids at a lon/lat point (bilinear on depth, nearest on arrival). */
export function sampleResult(
  result: SimulationResult,
  lon: number,
  lat: number,
): { depthM: number; arrivalS: number; velocityMs: number; groundM: number; inside: boolean } {
  const { grid } = result;
  const x = (lon - grid.crs.lon0) * mPerDegLon((lat + grid.crs.lat0) / 2);
  const y = (lat - grid.crs.lat0) * mPerDegLat(grid.crs.lat0);
  const fc = (x - grid.x0) / grid.dx;
  const fr = (y - grid.y0) / grid.dx;
  if (fc < 0 || fr < 0 || fc >= grid.nx - 1 || fr >= grid.ny - 1) {
    return { depthM: 0, arrivalS: -1, velocityMs: 0, groundM: NaN, inside: false };
  }
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  const tx = fc - c0;
  const ty = fr - r0;
  const at = (arr: Float32Array) =>
    arr[r0 * grid.nx + c0] * (1 - tx) * (1 - ty) +
    arr[r0 * grid.nx + c0 + 1] * tx * (1 - ty) +
    arr[(r0 + 1) * grid.nx + c0] * (1 - tx) * ty +
    arr[(r0 + 1) * grid.nx + c0 + 1] * tx * ty;
  const i = r0 * grid.nx + c0;
  return {
    depthM: Math.max(0, at(result.maxDepth)),
    arrivalS: result.arrivalTime[i],
    velocityMs: at(result.maxVelocity),
    groundM: at(grid.z),
    inside: true,
  };
}

function mPerDegLat(latDeg: number): number {
  const DEG = Math.PI / 180;
  const a = 6378137.0;
  const e2 = 0.0066943799901413165;
  const s = Math.sin(latDeg * DEG);
  const w = 1 - e2 * s * s;
  return ((a * (1 - e2)) / Math.pow(w, 1.5)) * DEG;
}
function mPerDegLon(latDeg: number): number {
  const DEG = Math.PI / 180;
  const a = 6378137.0;
  const e2 = 0.0066943799901413165;
  const s = Math.sin(latDeg * DEG);
  const w = 1 - e2 * s * s;
  return (a / Math.sqrt(w)) * Math.cos(latDeg * DEG) * DEG;
}

/** Area of a lon/lat ring in m² (planar approximation on the local projection). */
function ringAreaM2(ring: [number, number][], crs: Grid["crs"]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = toLocal(ring[i], crs);
    const q = toLocal(ring[(i + 1) % ring.length], crs);
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function toLocal(pt: [number, number], crs: Grid["crs"]): { x: number; y: number } {
  const latMean = (pt[1] + crs.lat0) / 2;
  return { x: (pt[0] - crs.lon0) * mPerDegLon(latMean), y: (pt[1] - crs.lat0) * mPerDegLat(crs.lat0) };
}

function centroidOf(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/**
 * Converts OSM buildings/roads into exposure results by sampling the modelled grids.
 * Sampling (rather than exact polygon clipping) is deliberate: at 10–30 m cells the raster
 * is the authoritative resolution of the model, and pretending otherwise would imply a
 * precision the DEM does not support.
 */
export function computeExposure(
  result: SimulationResult,
  assets: { buildings: OsmBuilding[]; roads: OsmRoad[] },
  reportingDepthM: number,
): ExposureResult {
  const notes: string[] = [];
  const buildings: BuildingImpact[] = [];
  const band = { low: 0, moderate: 0, high: 0 };
  let footprintArea = 0;

  for (const b of assets.buildings) {
    const ring = b.rings[0];
    if (!ring || ring.length < 3) continue;
    const area = Math.abs(ringAreaM2(ring, result.grid.crs));
    footprintArea += area;
    // Sample the footprint interior: vertices + centroid + midpoints (cheap, robust).
    const pts: [number, number][] = [...ring];
    const [cx, cy] = centroidOf(ring);
    pts.push([cx, cy]);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      pts.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    let maxDepth = 0;
    let arrival = -1;
    for (const p of pts) {
      const s = sampleResult(result, p[0], p[1]);
      if (!s.inside) continue;
      if (s.depthM > maxDepth) maxDepth = s.depthM;
      if (s.arrivalS >= 0 && (arrival < 0 || s.arrivalS < arrival)) arrival = s.arrivalS;
    }
    if (maxDepth < reportingDepthM) continue;
    const impact: BuildingImpact = {
      id: b.id,
      name: b.name,
      kind: b.kind,
      maxDepthM: maxDepth,
      arrivalTimeS: arrival,
      footprintAreaM2: area,
      footprintCentroid: { lng: cx, lat: cy },
    };
    buildings.push(impact);
    if (maxDepth >= 1.0) band.high++;
    else if (maxDepth >= 0.3) band.moderate++;
    else band.low++;
  }

  // ---- roads: densify each polyline and accumulate affected length ----------
  const roads: RoadImpact[] = [];
  const roadByClass: Record<string, number> = {};
  let roadAffected = 0;
  let roadTotal = 0;
  const stepM = Math.max(2, result.grid.dx / 2);

  for (const r of assets.roads) {
    let total = 0;
    let affected = 0;
    let maxDepth = 0;
    for (let i = 0; i < r.coords.length - 1; i++) {
      const a = r.coords[i];
      const b = r.coords[i + 1];
      const segLen = Math.hypot(
        (b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2),
        (b[1] - a[1]) * mPerDegLat(a[1]),
      );
      total += segLen;
      const n = Math.max(1, Math.ceil(segLen / stepM));
      const piece = segLen / n;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const lon = a[0] + (b[0] - a[0]) * t;
        const lat = a[1] + (b[1] - a[1]) * t;
        const s = sampleResult(result, lon, lat);
        if (s.depthM >= reportingDepthM) {
          affected += piece;
          if (s.depthM > maxDepth) maxDepth = s.depthM;
        }
      }
    }
    roadTotal += total;
    if (affected <= 0) continue;
    roadAffected += affected;
    const cls = r.highway ?? "unknown";
    roadByClass[cls] = (roadByClass[cls] ?? 0) + affected;
    roads.push({
      id: r.id,
      name: r.name,
      highway: r.highway,
      affectedLengthM: affected,
      maxDepthM: maxDepth,
      totalLengthM: total,
    });
  }

  if (assets.buildings.length === 0) {
    notes.push(
      "No building footprints were returned for this area. In OSM that usually means the area is unmapped rather than that no buildings exist — treat the building count as unknown, not as zero.",
    );
  }
  notes.push(
    "Assets are counted as EXPOSED TO MODELLED FLOODING when the modelled water depth at their footprint reaches the reporting threshold. This is not a damage assessment.",
  );

  return {
    buildings,
    roads,
    totals: {
      buildingCount: buildings.length,
      buildingFootprintAreaM2: footprintArea,
      buildingByBand: band,
      roadAffectedM: roadAffected,
      roadTotalM: roadTotal,
      roadByClass,
    },
    notes,
  };
}
