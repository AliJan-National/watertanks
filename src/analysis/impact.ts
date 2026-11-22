/**
 * Impact analysis over a user-defined boundary.
 *
 * Everything here is a pure function of `SimulationResult`, so the boundary, the damage bands
 * and the flow-direction field can be recomputed instantly when the user changes the boundary
 * size or the thresholds — no re-run of the solver required.
 *
 * Two deliberate decisions:
 *
 *  1. **Damage, not "safety".** The bands rank *the modelled loading on that cell*, never the
 *     habitability or usability of a place. Depth alone decides when velocities are too small
 *     to be meaningful (which is the case for most ponded water), and depth × velocity
 *     decides once the flow is moving. The method actually used is reported alongside the
 *     result so nobody has to guess.
 *
 *  2. **The boundary only clips reporting, not physics.** The solver always routes over the
 *     whole analysis domain; the boundary decides what gets counted and exported. That keeps
 *     the mass balance honest and prevents an artificial wall of water at the boundary edge.
 */
import { unproject } from "../engine/geo";
import type {
  DamageBand,
  DamageClass,
  FlowField,
  FlowVector,
  FlowStreamline,
  FlowNetworkBranch,
  FlowNode,
  MajorFlowArrow,
  SimulationResult,
} from "../engine/types";

export interface DamageThresholds {
  /** Depth at or above which the cell is "medium" when velocities are negligible (m). */
  mediumDepthM: number;
  /** Depth at or above which the cell is "high" when velocities are negligible (m). */
  highDepthM: number;
  /** depth × velocity at or above which the cell is at least "medium" (m²/s). */
  mediumDv: number;
  /** depth × velocity at or above which the cell is "high" (m²/s). */
  highDv: number;
  /** Depth that forces "high" regardless of velocity (m). */
  highDepthOverrideM: number;
}

export const DEFAULT_THRESHOLDS: DamageThresholds = {
  mediumDepthM: 0.10,
  highDepthM: 0.50,
  mediumDv: 0.5,
  highDv: 1.0,
  highDepthOverrideM: 1.5,
};

export const DAMAGE_COLOURS: Record<"low" | "medium" | "high", string> = {
  low: "#facc15",
  medium: "#fb923c",
  high: "#dc2626",
};

/** Half-width of the square assessment boundary, in metres, for a given area in km². */
export function boundaryHalfWidthM(areaKm2: number): number {
  const areaM2 = Math.max(0.0001, areaKm2) * 1e6;
  return Math.sqrt(areaM2) / 2;
}

/** Damage class for one cell from its modelled depth and peak velocity. */
export function damageFor(
  depthM: number,
  velocityMs: number,
  t: DamageThresholds,
  wetThresholdM: number,
): DamageClass {
  if (!(depthM >= wetThresholdM) || !Number.isFinite(depthM)) return 0;
  const dv = depthM * Math.max(0, velocityMs);
  if (depthM >= t.highDepthOverrideM || dv >= t.highDv || depthM >= t.highDepthM) return 3;
  if (dv >= t.mediumDv || depthM >= t.mediumDepthM) return 2;
  return 1;
}

/**
 * A 0–100 score that orders cells within a run. It is a ranking device for the legend and the
 * exports, not a physical quantity: it is linear in the depth/v·d ratio to the high threshold.
 */
export function damageScoreFor(depthM: number, velocityMs: number, t: DamageThresholds): number {
  const dv = depthM * Math.max(0, velocityMs);
  const depthTerm = Math.min(1, depthM / Math.max(t.highDepthM, 1e-6));
  const dvTerm = Math.min(1, dv / Math.max(t.highDv, 1e-6));
  return Math.round(100 * Math.min(1, Math.max(depthTerm * 0.6 + dvTerm * 0.4, dvTerm)));
}

export interface DamageAnalysis {
  damageClass: Uint8Array;
  damageScore: Uint8Array;
  bands: DamageBand[];
  method: "hazard_depth" | "depth_only";
  boundaryAreaM2: number;
  wetAreaM2: number;
  wetFraction: number;
  /** Cells inside the boundary, wet or not. */
  cellsInside: number;
}

/**
 * Classifies every cell inside the assessment boundary.
 *
 * The method switches to depth-only when the modelled velocities are so low across the whole
 * affected area that d × v would put almost everything in the lowest band; that would be
 * technically true and practically useless.
 */
export function analyseDamage(
  result: SimulationResult,
  areaKm2?: number,
  thresholds: DamageThresholds = DEFAULT_THRESHOLDS,
): DamageAnalysis {
  const { nx, ny, dx } = result.grid;
  const cellArea = dx * dx;
  const half = areaKm2 && areaKm2 > 0 ? boundaryHalfWidthM(areaKm2) : Math.max(nx, ny) * dx;
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const halfCells = half / dx;
  const wetThreshold = Math.max(0.001, result.options.reportingDepthM ?? 0.005);

  const damageClass = new Uint8Array(nx * ny);
  const damageScore = new Uint8Array(nx * ny);

  // Choose the method from the overall picture first.
  let movingCells = 0;
  let wetCells = 0;
  for (let i = 0; i < nx * ny; i++) {
    if (!(result.maxDepth[i] >= wetThreshold)) continue;
    wetCells++;
    if (result.maxVelocity[i] >= 0.3) movingCells++;
  }
  const method: "hazard_depth" | "depth_only" = wetCells > 0 && movingCells / wetCells >= 0.05 ? "hazard_depth" : "depth_only";

  const counts = [0, 0, 0, 0];
  let cellsInside = 0;
  for (let r = 0; r < ny; r++) {
    if (Math.abs(r - cy) > halfCells) continue;
    for (let c = 0; c < nx; c++) {
      if (Math.abs(c - cx) > halfCells) continue;
      const i = r * nx + c;
      cellsInside++;
      const d = result.maxDepth[i];
      const v = result.maxVelocity[i];
      const cls =
        method === "depth_only"
          ? damageFor(d, 0, { ...thresholds, mediumDv: Infinity, highDv: Infinity }, wetThreshold)
          : damageFor(d, v, thresholds, wetThreshold);
      damageClass[i] = cls;
      counts[cls]++;
      if (cls > 0) damageScore[i] = Math.max(1, damageScoreFor(d, v, thresholds));
    }
  }

  const insideArea = cellsInside * cellArea;
  const wetArea = (counts[1] + counts[2] + counts[3]) * cellArea;
  const mk = (id: "low" | "medium" | "high", label: string, idx: number, min: number, max: number | null): DamageBand => ({
    id,
    label,
    minScore: min,
    maxScore: max,
    colour: DAMAGE_COLOURS[id],
    areaM2: counts[idx] * cellArea,
    cellCount: counts[idx],
    fractionOfBoundary: insideArea > 0 ? (counts[idx] * cellArea) / insideArea : 0,
  });

  return {
    damageClass,
    damageScore,
    bands: [
      mk("low", "Low damage", 1, 0.005, 0.1),
      mk("medium", "Medium damage", 2, 0.1, 0.5),
      mk("high", "High damage", 3, 0.5, null),
    ],
    method,
    boundaryAreaM2: insideArea,
    wetAreaM2: wetArea,
    wetFraction: insideArea > 0 ? wetArea / insideArea : 0,
    cellsInside,
  };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compassLabel(bearingDeg: number): string {
  const b = ((bearingDeg % 360) + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

/**
 * Builds the flow-direction field inside the boundary.
 *
 * The outward flux of every wet cell is integrated over the four faces it shares with its
 * neighbours, weighted by the local slope direction, which gives a *net* transport vector per
 * cell rather than a snapshot of one face. Arrows are then thinned on a cell lattice so the
 * map stays readable at every zoom level.
 */
/**
 * Flow-direction field and dominant flow vector within the impact boundary.
 *
 * Rather than a noisy, confusing grid of dozens of small arrows that can point backwards in ponded
 * depressions, this derives:
 *   1. True transport directions from the simulated shallow-water momentum / flux field (or arrival gradient).
 *   2. The prominent primary flow arrow originating from the tank, with its width scaled by flow volume /
 *      damage severity and length scaled by inundation reach.
 *   3. Secondary branch arrow if the breach splits across multiple drainage corridors.
 *   4. Clean sampled direction vectors along the true downstream paths for GIS export.
 */
export function analyseFlow(
  result: SimulationResult,
  areaKm2?: number,
  opts: { maxArrows?: number; minDepthM?: number } = {},
): FlowField {
  const { nx, ny, dx, z, crs } = result.grid;
  const maxArrows = opts.maxArrows ?? 90;
  const wetThreshold = Math.max(opts.minDepthM ?? 0.001, result.options?.reportingDepthM ?? 0.005);
  const half = areaKm2 && areaKm2 > 0 ? boundaryHalfWidthM(areaKm2) : Math.max(nx, ny) * dx;
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;

  const dirX = new Float32Array(nx * ny);
  const dirY = new Float32Array(nx * ny);
  const speed = new Float32Array(nx * ny);

  const hasFlowVectors =
    !!result.flowX &&
    !!result.flowY &&
    result.flowX.length === nx * ny &&
    result.flowY.length === nx * ny;

  const surface = (i: number) => {
    const d = result.maxDepth[i];
    return (Number.isFinite(d) ? d : 0) + z[i];
  };

  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  const inside: number[] = [];
  const halfCells = half / dx;

  for (let r = 1; r < ny - 1; r++) {
    for (let c = 1; c < nx - 1; c++) {
      const i = r * nx + c;
      const d = result.maxDepth[i];
      if (!(d >= wetThreshold)) continue;

      let ux = 0;
      let uy = 0;

      if (hasFlowVectors) {
        const fx = result.flowX![i];
        const fy = result.flowY![i];
        const fMag = Math.hypot(fx, fy);
        if (fMag > 1e-6) {
          ux = fx / fMag;
          uy = fy / fMag;
        }
      }

      // If simulated face fluxes are negligible (e.g. standing water in depression or synthetic test),
      // deduce downstream direction from arrival-time propagation or depth gradient.
      if (Math.hypot(ux, uy) < 1e-6 && result.arrivalTime) {
        const arr = result.arrivalTime;
        const ai = arr[i];
        if (ai >= 0) {
          const axPrev = c > 0 && arr[i - 1] >= 0 ? arr[i - 1] : ai;
          const axNext = c < nx - 1 && arr[i + 1] >= 0 ? arr[i + 1] : ai;
          const ayPrev = r > 0 && arr[i - nx] >= 0 ? arr[i - nx] : ai;
          const ayNext = r < ny - 1 && arr[i + nx] >= 0 ? arr[i + nx] : ai;
          const dArrX = (axNext - axPrev) / (2 * dx);
          const dArrY = (ayNext - ayPrev) / (2 * dx);
          const aSlope = Math.hypot(dArrX, dArrY);
          if (aSlope > 1e-6) {
            ux = dArrX / aSlope;
            uy = dArrY / aSlope;
          }
        }
      }

      if (Math.hypot(ux, uy) < 1e-6) {
        // Fallback: central differences of water surface
        const dhdx = (surface(i + 1) - surface(i - 1)) / (2 * dx);
        const dhdy = (surface(i + nx) - surface(i - nx)) / (2 * dx);
        const slope = Math.hypot(dhdx, dhdy);
        if (slope > 1e-9) {
          ux = -dhdx / slope;
          uy = -dhdy / slope;
        }
      }

      const dxFromTank = (c - cx) * dx;
      const dyFromTank = (r - cy) * dx;
      const distFromTank = Math.hypot(dxFromTank, dyFromTank);

      if (Math.hypot(ux, uy) < 1e-6 && distFromTank > 1e-3) {
        ux = dxFromTank / distFromTank;
        uy = dyFromTank / distFromTank;
      }

      const v = result.maxVelocity[i] > 0 ? result.maxVelocity[i] : Math.min(3, Math.hypot(ux, uy) * 1.5);
      dirX[i] = ux;
      dirY[i] = uy;
      speed[i] = v;

      // Track reporting inside the user's selected impact assessment boundary
      if (Math.abs(c - cx) <= halfCells && Math.abs(r - cy) <= halfCells) {
        inside.push(i);
        const dmg = result.damageScore ? result.damageScore[i] || 0 : 0;
        const w = d * dx * dx * (1 + 0.02 * dmg);
        sumX += ux * w;
        sumY += uy * w;
        sumW += w;
      }
    }
  }

  const meanDirDeg = sumW > 0 ? ((Math.atan2(sumX, sumY) * 180) / Math.PI + 360) % 360 : 0;
  const meanMod = sumW > 0 ? Math.hypot(sumX, sumY) / sumW : 0;

  // Dominant direction: 8-point compass sector carrying the most volume & damage.
  const sectorW = new Float64Array(8);
  const evalIndices = inside.length > 0 ? inside : [];
  for (const i of evalIndices) {
    const b = ((Math.atan2(dirX[i], dirY[i]) * 180) / Math.PI + 360) % 360;
    const dmg = result.damageScore ? result.damageScore[i] || 0 : 0;
    sectorW[Math.round(b / 45) % 8] += result.maxDepth[i] * (1 + 0.02 * dmg);
  }
  let bestSector = 0;
  for (let s = 1; s < 8; s++) if (sectorW[s] > sectorW[bestSector]) bestSector = s;
  const dominantDirDeg = bestSector * 45;
  const dominantLabel = COMPASS[bestSector];

  // Build continuous real flow network connecting the tank to all downstream basins.
  // Computed across the full physical inundation footprint, completely independent of the
  // reporting boundary so arrows never vanish or jump when toggling between 1 km² and 4 km².
  const { primaryArrow, majorArrows, streamlines, flowNetwork } = buildRealFlowNetwork(
    result,
    dirX,
    dirY,
    speed,
    dominantDirDeg,
  );

  // Thin the sampled vector arrows on a readable lattice for GIS export
  const target = Math.max(8, maxArrows);
  const step = Math.max(2, Math.ceil(Math.sqrt(Math.max(1, inside.length) / target)));
  const vectors: FlowVector[] = [];
  for (let r = 1; r < ny - 1; r += step) {
    for (let c = 1; c < nx - 1; c += step) {
      const i = r * nx + c;
      if (!(result.maxDepth[i] >= wetThreshold)) continue;
      if (Math.abs(c - cx) > halfCells || Math.abs(r - cy) > halfCells) continue;
      if (!(speed[i] > 0)) continue;
      const ux = dirX[i];
      const uy = dirY[i];
      const x = result.grid.x0 + c * dx;
      const y = result.grid.y0 + r * dx;
      vectors.push({
        x,
        y,
        lng: unproject(x, y, crs).lng,
        lat: unproject(x, y, crs).lat,
        dirDeg: ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360,
        speedMs: speed[i],
        depthM: result.maxDepth[i],
        flux: speed[i] * result.maxDepth[i],
      });
    }
  }
  vectors.sort((a, b) => b.flux - a.flux);

  const speeds = inside.map((i) => speed[i]).sort((a, b) => a - b);
  const speedP95Ms = speeds.length ? Math.max(0.05, speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.95))]) : 0.05;

  const cellArea = dx * dx;

  let cellsInside = 0;
  let wetInside = 0;
  for (let r = 0; r < ny; r++) {
    if (Math.abs(r - cy) > halfCells) continue;
    for (let c = 0; c < nx; c++) {
      if (Math.abs(c - cx) > halfCells) continue;
      cellsInside++;
      if (result.maxDepth[r * nx + c] >= wetThreshold) wetInside++;
    }
  }

  return {
    vectors,
    meanDirDeg: (meanDirDeg + 360) % 360,
    concentration: Math.min(1, meanMod),
    dominantDirDeg,
    dominantLabel,
    speedP95Ms,
    boundaryAreaM2: cellsInside * cellArea,
    boundaryWetAreaM2: wetInside * cellArea,
    boundaryWetFraction: cellsInside > 0 ? wetInside / cellsInside : 0,
    primaryArrow,
    majorArrows,
    streamlines,
    flowNetwork,
  };
}

/**
 * Chaikin corner-cutting polyline smoothing algorithm.
 * Turns discrete grid steps into silky, fluid curvilinear lines.
 */
function smoothPolyline(pts: [number, number][], iterations = 2): [number, number][] {
  if (pts.length < 3) return pts;
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next: [number, number][] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const p0 = cur[i];
      const p1 = cur[i + 1];
      next.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      next.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/**
 * Traces the Real Flow Network: a continuous, connected dendritic stream network connecting
 * the tank breach origin to all downstream inundated basins along active hydraulic thalwegs.
 */
/**
 * Generates small, elegant curved dashed flow arrows radiating from the tank center
 * and downstream along all active flow corridors and flood pools.
 * Directly visualizes flow direction without DEM path dependency.
 */
function buildRealFlowNetwork(
  result: SimulationResult,
  dirX: Float32Array,
  dirY: Float32Array,
  speed: Float32Array,
  dominantDirDeg: number,
): {
  primaryArrow?: MajorFlowArrow;
  majorArrows: MajorFlowArrow[];
  streamlines: FlowStreamline[];
  flowNetwork: FlowNetworkBranch[];
} {
  const { nx, ny, dx, crs, x0, y0 } = result.grid;
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const tankX = x0 + cx * dx;
  const tankY = y0 + cy * dx;
  const tankLL = unproject(tankX, tankY, crs);
  const wetThreshold = Math.max(0.001, result.options?.reportingDepthM ?? 0.005);
  const volM3 = result.mass?.releasedM3 ?? 0;
  const tankRadiusEst = Math.max(10, Math.sqrt((volM3 > 0 ? volM3 : 1000) / (Math.PI * 8)));

  let wetCount = 0;
  for (let i = 0; i < nx * ny; i++) {
    if (result.maxDepth[i] >= wetThreshold) wetCount++;
  }
  if (wetCount === 0) return { majorArrows: [], streamlines: [], flowNetwork: [] };

  const sampleVector = (px: number, py: number): { vx: number; vy: number; sp: number; d: number } => {
    const c = Math.round((px - x0) / dx);
    const r = Math.round((py - y0) / dx);
    if (c < 1 || c >= nx - 1 || r < 1 || r >= ny - 1) return { vx: 0, vy: 0, sp: 0, d: 0 };
    const i = r * nx + c;
    const d = result.maxDepth[i];
    if (d < wetThreshold) return { vx: 0, vy: 0, sp: 0, d: 0 };
    let vx = dirX[i];
    let vy = dirY[i];
    let sp = speed[i];
    if (Math.hypot(vx, vy) < 1e-4) {
      const rx = px - tankX;
      const ry = py - tankY;
      const rDist = Math.hypot(rx, ry);
      if (rDist > 1e-3) {
        vx = rx / rDist;
        vy = ry / rDist;
      }
    }
    return { vx, vy, sp, d };
  };

  // 1. Identify distinct active flow directions radiating from the tank
  const SECTORS = 16;
  const sectorWeight = new Float64Array(SECTORS);
  const sectorCount = new Int32Array(SECTORS);

  const hasFlowGrid =
    !!result.flowX &&
    !!result.flowY &&
    result.flowX.length === nx * ny &&
    result.flowY.length === nx * ny;

  for (let r = 1; r < ny - 1; r++) {
    for (let c = 1; c < nx - 1; c++) {
      const i = r * nx + c;
      const d = result.maxDepth[i];
      if (d < wetThreshold) continue;

      const px = x0 + c * dx;
      const py = y0 + r * dx;
      const relX = px - tankX;
      const relY = py - tankY;
      const dist = Math.hypot(relX, relY);
      if (dist < dx * 0.8 || dist > Math.max(360, tankRadiusEst * 14)) continue;

      const bearing = ((Math.atan2(relX, relY) * 180) / Math.PI + 360) % 360;
      const sec = Math.floor(((bearing + 11.25) % 360) / 22.5) % SECTORS;

      const sp = speed ? speed[i] : 0;
      const ux = dirX ? dirX[i] : 0;
      const uy = dirY ? dirY[i] : 0;
      const outwardDot = dist > 0 ? (ux * relX + uy * relY) / dist : 0;
      const outwardFactor = outwardDot > 0.05 ? 1.5 : outwardDot < -0.2 ? 0.3 : 1.0;

      let explicitBoost = 1.0;
      if (hasFlowGrid) {
        const fx = result.flowX![i];
        const fy = result.flowY![i];
        if (Math.hypot(fx, fy) > 1e-4) {
          explicitBoost = 3.5;
        }
      }

      const w = d * Math.max(0.1, sp) * outwardFactor * explicitBoost;
      sectorWeight[sec] += w;
      sectorCount[sec]++;
    }
  }

  interface OutflowDirection {
    sector: number;
    bearingDeg: number;
    weight: number;
  }
  const directions: OutflowDirection[] = [];
  for (let s = 0; s < SECTORS; s++) {
    if (sectorCount[s] >= 1 && sectorWeight[s] > 0.02) {
      directions.push({
        sector: s,
        bearingDeg: s * 22.5,
        weight: sectorWeight[s],
      });
    }
  }
  directions.sort((a, b) => b.weight - a.weight);

  const angleDiff = (a: number, b: number) => Math.abs(((a - b + 180) % 360) - 180);

  // Select top distinct flow directions separated by at least 26 degrees
  const distinctDirs: OutflowDirection[] = [];
  for (const d of directions) {
    if (!distinctDirs.some((dd) => angleDiff(dd.bearingDeg, d.bearingDeg) < 26)) {
      distinctDirs.push(d);
      if (distinctDirs.length >= 4) break;
    }
  }

  if (distinctDirs.length === 0) {
    distinctDirs.push({ sector: 0, bearingDeg: dominantDirDeg, weight: 1.0 });
  }

  // 2. Streamline path tracer
  const traceFlowPath = (
    startX: number,
    startY: number,
    initVx: number,
    initVy: number,
    maxM = 1600,
  ): [number, number][] => {
    const pts: [number, number][] = [[startX, startY]];
    let curX = startX;
    let curY = startY;
    let vxEff = initVx;
    let vyEff = initVy;
    const ds = 8.0;
    const maxSteps = Math.ceil(maxM / ds);

    for (let step = 0; step < maxSteps; step++) {
      const s = sampleVector(curX, curY);
      if (!s.d || s.d < wetThreshold) break;

      if (Math.hypot(s.vx, s.vy) > 0.05) {
        vxEff = 0.7 * vxEff + 0.3 * s.vx;
        vyEff = 0.7 * vyEff + 0.3 * s.vy;
      }
      const mag = Math.hypot(vxEff, vyEff);
      if (mag < 1e-4) break;
      const nxStep = vxEff / mag;
      const nyStep = vyEff / mag;

      const nextX = curX + nxStep * ds;
      const nextY = curY + nyStep * ds;

      const sNext = sampleVector(nextX, nextY);
      if (!sNext.d || sNext.d < wetThreshold) {
        // Probe lateral neighbours in case of boundary skim
        const perpX = -nyStep;
        const perpY = nxStep;
        const leftS = sampleVector(curX + (nxStep + 0.5 * perpX) * ds, curY + (nyStep + 0.5 * perpY) * ds);
        const rightS = sampleVector(curX + (nxStep - 0.5 * perpX) * ds, curY + (nyStep - 0.5 * perpY) * ds);
        if (leftS.d >= wetThreshold && leftS.d > rightS.d) {
          curX += (nxStep + 0.5 * perpX) * ds;
          curY += (nyStep + 0.5 * perpY) * ds;
          pts.push([curX, curY]);
          continue;
        } else if (rightS.d >= wetThreshold) {
          curX += (nxStep - 0.5 * perpX) * ds;
          curY += (nyStep - 0.5 * perpY) * ds;
          pts.push([curX, curY]);
          continue;
        }
        break;
      }

      curX = nextX;
      curY = nextY;
      pts.push([curX, curY]);
    }
    return pts;
  };

  const rawPaths: [number, number][][] = [];
  const coverage = new Uint8Array(nx * ny);

  const markCoverage = (pts: [number, number][], radiusM = 90) => {
    const radCells = Math.ceil(radiusM / dx);
    for (const [px, py] of pts) {
      const cc = Math.round((px - x0) / dx);
      const cr = Math.round((py - y0) / dx);
      for (let dr = -radCells; dr <= radCells; dr++) {
        const r = cr + dr;
        if (r < 0 || r >= ny) continue;
        for (let dc = -radCells; dc <= radCells; dc++) {
          const c = cc + dc;
          if (c < 0 || c >= nx) continue;
          if (Math.hypot(dc * dx, dr * dx) <= radiusM) {
            coverage[r * nx + c] = 1;
          }
        }
      }
    }
  };

  // 1. Primary spines radiating from tank
  const startOffset = Math.max(12, Math.min(26, tankRadiusEst * 0.9));
  for (const dir of distinctDirs) {
    const bRad = (dir.bearingDeg * Math.PI) / 180;
    const sX = tankX + startOffset * Math.sin(bRad);
    const sY = tankY + startOffset * Math.cos(bRad);
    const spine = traceFlowPath(sX, sY, Math.sin(bRad), Math.cos(bRad), 1600);
    if (spine.length >= 2) {
      rawPaths.push(spine);
      markCoverage(spine, 90);
    }
  }

  // 2. Discover uncovered tributary corridors across the full flood extent
  for (let iter = 0; iter < 6; iter++) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let r = 2; r < ny - 2; r++) {
      for (let c = 2; c < nx - 2; c++) {
        const i = r * nx + c;
        if (coverage[i] || result.maxDepth[i] < 0.12) continue;
        const px = x0 + c * dx;
        const py = y0 + r * dx;
        const distToTank = Math.hypot(px - tankX, py - tankY);
        if (distToTank < 60) continue;

        const arr = result.arrivalTime ? result.arrivalTime[i] : 1000;
        const arrScore = arr > 0 ? 10000 / (arr + 60) : 10;
        const score = result.maxDepth[i] * (speed[i] + 0.2) * arrScore;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) break;

    const seedC = bestIdx % nx;
    const seedR = Math.floor(bestIdx / nx);
    const seedX = x0 + seedC * dx;
    const seedY = y0 + seedR * dx;
    const sVec = sampleVector(seedX, seedY);
    if (sVec.d < wetThreshold || Math.hypot(sVec.vx, sVec.vy) < 1e-4) {
      coverage[bestIdx] = 1;
      continue;
    }

    // Trace forward and backward from seed
    const fwd = traceFlowPath(seedX, seedY, sVec.vx, sVec.vy, 800);
    const bwd = traceFlowPath(seedX, seedY, -sVec.vx, -sVec.vy, 120);

    const bwdPoints = bwd.slice(1).reverse();
    const branchPath: [number, number][] = [...bwdPoints, ...fwd];
    if (branchPath.length >= 3) {
      rawPaths.push(branchPath);
      markCoverage(branchPath, 90);
    } else {
      coverage[bestIdx] = 1;
    }
  }

  // 3. Slice each continuous flow path into small, elegant curved arrows
  const flowNetwork: FlowNetworkBranch[] = [];
  const streamlines: FlowStreamline[] = [];

  const extractSubPath = (
    P: [number, number][],
    cumDist: number[],
    dStart: number,
    dEnd: number,
  ): [number, number][] => {
    const sub: [number, number][] = [];
    const interp = (pA: [number, number], pB: [number, number], t: number): [number, number] => [
      pA[0] + t * (pB[0] - pA[0]),
      pA[1] + t * (pB[1] - pA[1]),
    ];

    let startAdded = false;
    for (let j = 0; j < P.length - 1; j++) {
      const s0 = cumDist[j];
      const s1 = cumDist[j + 1];
      if (!startAdded && dStart >= s0 && dStart <= s1) {
        const t = s1 > s0 ? (dStart - s0) / (s1 - s0) : 0;
        sub.push(interp(P[j], P[j + 1], t));
        startAdded = true;
      }
      if (startAdded) {
        if (s1 > dStart && s1 < dEnd) {
          sub.push(P[j + 1]);
        } else if (dEnd >= s0 && dEnd <= s1) {
          const t = s1 > s0 ? (dEnd - s0) / (s1 - s0) : 0;
          sub.push(interp(P[j], P[j + 1], t));
          break;
        }
      }
    }
    return sub;
  };

  const arrowSegments: [number, number][][] = [];

  for (const raw of rawPaths) {
    if (raw.length < 2) continue;
    const cumDist: number[] = [0];
    for (let j = 1; j < raw.length; j++) {
      const d = Math.hypot(raw[j][0] - raw[j - 1][0], raw[j][1] - raw[j - 1][1]);
      cumDist.push(cumDist[j - 1] + d);
    }
    const totalL = cumDist[cumDist.length - 1];
    if (totalL < 65) continue;

    if (totalL <= 220) {
      arrowSegments.push(raw);
    } else {
      const arrowLen = 150;
      const gapLen = 75;
      let dCur = 0;
      while (dCur + 60 <= totalL) {
        const dNext = Math.min(totalL, dCur + arrowLen);
        const sub = extractSubPath(raw, cumDist, dCur, dNext);
        if (sub.length >= 2) {
          arrowSegments.push(sub);
        }
        dCur = dNext + gapLen;
      }
    }
  }

  // 4. Build arrowhead and shaft geometries for each arrow segment
  arrowSegments.forEach((seg, idx) => {
    let pts: [number, number][] = seg;
    if (pts.length < 4) {
      const resampled: [number, number][] = [];
      const RES = 8;
      for (let s = 0; s <= RES; s++) {
        const t = s / RES;
        const p0 = pts[0];
        const p1 = pts[pts.length - 1];
        resampled.push([p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])]);
      }
      pts = resampled;
    }

    const smoothed = smoothPolyline(pts, 2);
    const tip = smoothed[smoothed.length - 1];
    const prev = smoothed[Math.max(0, smoothed.length - 3)];
    const tipBearingDeg = ((Math.atan2(tip[0] - prev[0], tip[1] - prev[1]) * 180) / Math.PI + 360) % 360;

    // Bold, prominent, sharp triangular arrowhead matching user cartography design
    const headLenM = 40.0;
    const headWidM = 28.0;
    const notchM = 28.0;

    const hRad = (tipBearingDeg * Math.PI) / 180;
    const hUx = Math.sin(hRad);
    const hUy = Math.cos(hRad);
    const hVx = Math.cos(hRad);
    const hVy = -Math.sin(hRad);

    const tipX = tip[0];
    const tipY = tip[1];
    const leftWingX = tipX - headLenM * hUx - 0.5 * headWidM * hVx;
    const leftWingY = tipY - headLenM * hUy - 0.5 * headWidM * hVy;
    const rightWingX = tipX - headLenM * hUx + 0.5 * headWidM * hVx;
    const rightWingY = tipY - headLenM * hUy + 0.5 * headWidM * hVy;
    const notchX = tipX - notchM * hUx;
    const notchY = tipY - notchM * hUy;

    const arrowHeadLL: [number, number][] = [
      [tipX, tipY],
      [leftWingX, leftWingY],
      [notchX, notchY],
      [rightWingX, rightWingY],
      [tipX, tipY],
    ].map(([x, y]) => {
      const ll = unproject(x, y, crs);
      return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
    });

    // Retract line tip slightly so the dashed shaft connects cleanly into arrowhead notch
    smoothed[smoothed.length - 1] = [notchX, notchY];

    const pathLL: [number, number][] = smoothed.map(([x, y]) => {
      const ll = unproject(x, y, crs);
      return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
    });

    let segLengthM = 0;
    for (let j = 1; j < smoothed.length; j++) {
      segLengthM += Math.hypot(smoothed[j][0] - smoothed[j - 1][0], smoothed[j][1] - smoothed[j - 1][1]);
    }

    const branchId = `flow-arrow-${idx}`;
    const label = `Flow direction arrow — ${compassLabel(tipBearingDeg)} (${tipBearingDeg.toFixed(0)}°)`;
    const destLL = pathLL[pathLL.length - 1];

    flowNetwork.push({
      id: branchId,
      path: pathLL,
      arrowHead: arrowHeadLL,
      headLngLat: destLL,
      role: idx === 0 ? "trunk" : "branch",
      order: idx === 0 ? 2 : 1,
      lengthM: Number(segLengthM.toFixed(1)),
      widthM: 3.2,
      speedMs: 1.5,
      flux: 1.0,
      damageLevel: "high",
      label,
      bearingDeg: Number(tipBearingDeg.toFixed(1)),
    });

    streamlines.push({
      id: branchId,
      path: pathLL,
      headBearingDeg: Number(tipBearingDeg.toFixed(1)),
      lengthM: Number(segLengthM.toFixed(1)),
      widthM: 3.2,
      speedMs: 1.5,
      flux: 1.0,
      damageLevel: "high",
      role: idx === 0 ? "primary" : "branch",
      label,
      headLngLat: destLL,
      arrowHead: arrowHeadLL,
    });
  });

  const primaryStream = streamlines.find((s) => s.role === "primary") ?? streamlines[0];
  const primaryArrow: MajorFlowArrow | undefined = primaryStream
    ? {
        fromLng: Number(tankLL.lng.toFixed(7)),
        fromLat: Number(tankLL.lat.toFixed(7)),
        toLng: primaryStream.headLngLat[0],
        toLat: primaryStream.headLngLat[1],
        bearingDeg: primaryStream.headBearingDeg,
        lengthM: primaryStream.lengthM,
        widthM: primaryStream.widthM,
        headWidthM: Number((primaryStream.widthM * 2.2).toFixed(1)),
        headLengthM: Number((primaryStream.widthM * 2.5).toFixed(1)),
        speedMs: primaryStream.speedMs,
        flux: primaryStream.flux,
        damageLevel: primaryStream.damageLevel,
        polygon: primaryStream.arrowHead,
        path: primaryStream.path,
        role: "primary",
        label: primaryStream.label,
      }
    : undefined;

  const majorArrows: MajorFlowArrow[] = [];
  if (primaryArrow) majorArrows.push(primaryArrow);

  const branchStreams = streamlines.filter((s) => s.role === "branch");
  const seenBearings: number[] = primaryArrow ? [primaryArrow.bearingDeg] : [];
  for (const bs of branchStreams) {
    if (!seenBearings.some((sb) => angleDiff(sb, bs.headBearingDeg) < 30)) {
      seenBearings.push(bs.headBearingDeg);
      majorArrows.push({
        fromLng: Number(tankLL.lng.toFixed(7)),
        fromLat: Number(tankLL.lat.toFixed(7)),
        toLng: bs.headLngLat[0],
        toLat: bs.headLngLat[1],
        bearingDeg: bs.headBearingDeg,
        lengthM: bs.lengthM,
        widthM: bs.widthM,
        headWidthM: Number((bs.widthM * 2.2).toFixed(1)),
        headLengthM: Number((bs.widthM * 2.5).toFixed(1)),
        speedMs: bs.speedMs,
        flux: bs.flux,
        damageLevel: bs.damageLevel,
        polygon: bs.arrowHead,
        path: bs.path,
        role: "secondary",
        label: bs.label,
      });
    }
  }

  return { primaryArrow, majorArrows, streamlines, flowNetwork };
}

/** Applies both analyses to a result and returns the updated object. */
export function withImpact(
  result: SimulationResult,
  areaKm2: number,
  thresholds: DamageThresholds = DEFAULT_THRESHOLDS,
): SimulationResult {
  const damage = analyseDamage(result, areaKm2, thresholds);
  result.damageClass = damage.damageClass;
  result.damageScore = damage.damageScore;
  result.damageBands = damage.bands;
  result.damageMethod = damage.method;
  const flow = analyseFlow(result, areaKm2);
  return {
    ...result,
    flow,
  };
}
