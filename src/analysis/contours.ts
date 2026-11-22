/**
 * Heat-map contouring for the damage field.
 *
 * The previous renderer drew one rectangle per classified cell. At a 1 km² boundary with 12 m
 * cells that is 27 separate blobs — legible as data, useless as a map. This module turns the
 * same classified cells into a handful of smooth polygons:
 *
 *   1. fill the grid with the per-cell damage score (0–100) and mask cells that carry no water;
 *   2. blur the score with a separable box blur, so the band edges are continuous across cell
 *      boundaries instead of stair-stepped;
 *   3. run marching squares at the two band thresholds and stitch the segments into closed
 *      rings;
 *   4. return one polygon per (band, connected region), outer ring first, with interior holes
 *      dropped by winding direction so the draw order stays correct.
 *
 * Everything is plain arithmetic — no canvas, no worker, no dependency.
 */
import { unproject } from "../engine/geo";
import type { SimulationResult } from "../engine/types";

export type BandId = "low" | "medium" | "high";

export interface ContourBand {
  id: BandId;
  /** Lower-inclusive threshold on the 0–100 damage score. */
  min: number;
  colour: string;
  /** WGS84 rings: [outer, ...holes]. */
  polygons: number[][][][];
  /** Contoured area in m², measured before the lon/lat conversion. */
  areaM2: number;
}

/** Band boundaries on the 0–100 score scale, matching `analyseDamage`'s classes. */
export const BAND_THRESHOLDS: { id: BandId; min: number; colour: string }[] = [
  { id: "high", min: 55, colour: "#dc2626" },
  { id: "medium", min: 22, colour: "#fb923c" },
  { id: "low", min: 1, colour: "#facc15" },
];

export interface ContourOptions {
  /** Blur passes, in cells. 2 gives a ~2-cell halo, which reads as a gradient. */
  smoothing?: number;
  /** Minimum ring area in cells; removes single-cell speckle. */
  minAreaCells?: number;
}

interface Grid2D {
  nx: number;
  ny: number;
  /** Row-major, row 0 = south. NaN = no data (masked out). */
  v: Float32Array;
}

/** Separable Gaussian-weighted blur (radius 1, 2 passes) for smooth, fluent water contours. */
function blur(src: Float32Array, nx: number, ny: number, passes: number): Float32Array {
  let a = src;
  const weights = [0.22, 0.56, 0.22];
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(nx * ny);
    // horizontal
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        let wSum = 0;
        for (let k = -1; k <= 1; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= nx) continue;
          const val = a[row + xx];
          if (!Number.isFinite(val)) continue;
          const w = weights[k + 1];
          sum += val * w;
          wSum += w;
        }
        b[row + x] = wSum > 0 ? sum / wSum : NaN;
      }
    }
    // vertical
    const c = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        let wSum = 0;
        for (let k = -1; k <= 1; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= ny) continue;
          const val = b[yy * nx + x];
          if (!Number.isFinite(val)) continue;
          const w = weights[k + 1];
          sum += val * w;
          wSum += w;
        }
        c[y * nx + x] = wSum > 0 ? sum / wSum : NaN;
      }
    }
    a = c;
  }
  return a;
}

/** Zero-padded Gaussian blur for continuous, fluent heat-map raster fields without pixel edges. */
function blurZeroPadded(src: Float32Array, nx: number, ny: number, passes: number): Float32Array {
  let a = src;
  const weights = [0.22, 0.56, 0.22];
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(nx * ny);
    // horizontal
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        for (let k = -1; k <= 1; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < nx) {
            const val = a[row + xx];
            if (Number.isFinite(val) && val > 0) sum += val * weights[k + 1];
          }
        }
        b[row + x] = sum;
      }
    }
    // vertical
    const c = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        for (let k = -1; k <= 1; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < ny) {
            const val = b[yy * nx + x];
            if (Number.isFinite(val) && val > 0) sum += val * weights[k + 1];
          }
        }
        c[y * nx + x] = sum;
      }
    }
    a = c;
  }
  return a;
}

/** Chaikin's corner-cutting algorithm for silky smooth organic fluid curves (closed rings or open polylines). */
export function smoothLine(pts: number[][], iterations = 2, isClosed = false): number[][] {
  if (pts.length < 3) return pts;
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next: number[][] = [];
    if (!isClosed) next.push(cur[0]);
    const n = isClosed ? cur.length - 1 : cur.length - 1;
    for (let i = 0; i < n; i++) {
      const p0 = cur[i];
      const p1 = cur[i + 1];
      next.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      next.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    if (isClosed) {
      next.push([next[0][0], next[0][1]]);
    } else {
      next.push(cur[cur.length - 1]);
    }
    cur = next;
  }
  return cur;
}

/** Chaikin's corner-cutting algorithm for silky smooth organic fluid curves. */
export function smoothRing(ring: number[][], iterations = 2): number[][] {
  return smoothLine(ring, iterations, true);
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Marching squares over the grid *vertex* field. Values are sampled at cell centres, so the
 * contour is offset by half a cell; that is corrected in the coordinate mapping.
 */
function marchingSquares(g: Grid2D, level: number): Seg[] {
  const { nx, ny, v } = g;
  const segs: Seg[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= nx || y >= ny ? NaN : v[y * nx + x]);

  for (let y = 0; y < ny - 1; y++) {
    for (let x = 0; x < nx - 1; x++) {
      const v00 = at(x, y);
      const v10 = at(x + 1, y);
      const v11 = at(x + 1, y + 1);
      const v01 = at(x, y + 1);
      if (![v00, v10, v11, v01].every(Number.isFinite)) continue;

      const idx =
        (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;

      // Interpolated crossing points on each edge of the cell.
      const il = (a: number, b: number) => (level - a) / (b - a);
      const west = () => ({ x, y: y + il(v00, v01) });
      const east = () => ({ x: x + 1, y: y + il(v10, v11) });
      const south = () => ({ x: x + il(v00, v10), y });
      const north = () => ({ x: x + il(v01, v11), y: y + 1 });

      const push = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

      switch (idx) {
        case 1:
        case 14:
          push(west(), south());
          break;
        case 2:
        case 13:
          push(south(), east());
          break;
        case 3:
        case 12:
          push(west(), east());
          break;
        case 4:
        case 11:
          push(east(), north());
          break;
        case 5:
          push(west(), north());
          push(south(), east());
          break;
        case 6:
        case 9:
          push(south(), north());
          break;
        case 7:
        case 8:
          push(west(), north());
          break;
        case 10:
          push(west(), south());
          push(east(), north());
          break;
        default:
          break;
      }
    }
  }
  return segs;
}

const key = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;

/** Stitches segments into closed rings (unordered input). */
function stitch(segs: Seg[]): number[][][] {
  const byPoint = new Map<string, number[]>();
  const pts: { x: number; y: number }[] = [];
  const add = (p: { x: number; y: number }) => {
    const k = key(p);
    let id = byPoint.get(k)?.find((i) => Math.abs(pts[i].x - p.x) < 1e-3 && Math.abs(pts[i].y - p.y) < 1e-3);
    if (id === undefined) {
      id = pts.length;
      pts.push(p);
      const list = byPoint.get(k) ?? [];
      list.push(id);
      byPoint.set(k, list);
    }
    return id;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (const s of segs) link(add({ x: s.x1, y: s.y1 }), add({ x: s.x2, y: s.y2 }));

  const rings: number[][][] = [];
  const usedEdge = new Set<string>();
  for (const [start] of adj) {
    const stack = adj.get(start);
    if (!stack || stack.length === 0) continue;
    const ring: number[][] = [];
    let cur = start;
    let prev = -1;
    for (let guard = 0; guard < pts.length * 4; guard++) {
      ring.push([pts[cur].x, pts[cur].y]);
      const nexts = (adj.get(cur) ?? []).filter((n) => !usedEdge.has(`${Math.min(cur, n)}-${Math.max(cur, n)}`));
      if (nexts.length === 0) break;
      const next = nexts[0];
      usedEdge.add(`${Math.min(cur, next)}-${Math.max(cur, next)}`);
      prev = cur;
      cur = next;
      if (cur === start) {
        ring.push([pts[start].x, pts[start].y]);
        break;
      }
    }
    if (ring.length >= 4 && cur === start) rings.push(ring);
    void prev;
  }
  return rings;
}

/** Stitches segments into both open polylines and closed rings. */
function stitchLines(segs: Seg[]): number[][][] {
  const byPoint = new Map<string, number[]>();
  const pts: { x: number; y: number }[] = [];
  const add = (p: { x: number; y: number }) => {
    const k = key(p);
    let id = byPoint.get(k)?.find((i) => Math.abs(pts[i].x - p.x) < 1e-3 && Math.abs(pts[i].y - p.y) < 1e-3);
    if (id === undefined) {
      id = pts.length;
      pts.push(p);
      const list = byPoint.get(k) ?? [];
      list.push(id);
      byPoint.set(k, list);
    }
    return id;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (const s of segs) link(add({ x: s.x1, y: s.y1 }), add({ x: s.x2, y: s.y2 }));

  const lines: number[][][] = [];
  const usedEdge = new Set<string>();

  // 1. Trace from endpoints with odd degree (open polylines across valleys) first
  for (const [start, neighbours] of adj) {
    if (neighbours.length % 2 !== 1) continue;
    let cur = start;
    const line: number[][] = [[pts[cur].x, pts[cur].y]];
    while (true) {
      const nexts = (adj.get(cur) ?? []).filter((n) => !usedEdge.has(`${Math.min(cur, n)}-${Math.max(cur, n)}`));
      if (nexts.length === 0) break;
      const next = nexts[0];
      usedEdge.add(`${Math.min(cur, next)}-${Math.max(cur, next)}`);
      cur = next;
      line.push([pts[cur].x, pts[cur].y]);
    }
    if (line.length >= 3) lines.push(line);
  }

  // 2. Trace remaining closed rings
  for (const [start] of adj) {
    let cur = start;
    const line: number[][] = [];
    while (true) {
      const nexts = (adj.get(cur) ?? []).filter((n) => !usedEdge.has(`${Math.min(cur, n)}-${Math.max(cur, n)}`));
      if (nexts.length === 0) break;
      line.push([pts[cur].x, pts[cur].y]);
      const next = nexts[0];
      usedEdge.add(`${Math.min(cur, next)}-${Math.max(cur, next)}`);
      cur = next;
      if (cur === start) {
        line.push([pts[start].x, pts[start].y]);
        break;
      }
    }
    if (line.length >= 4 && cur === start) lines.push(line);
  }

  return lines;
}

function ringArea(r: number[][]): number {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}

/**
 * Builds smooth band polygons from a finished run.
 *
 * The score field is `damageScore` (0–100) where the cell is wet, masked elsewhere. Because
 * the scores are computed from max depth and peak velocity, the contours describe the peak
 * envelope of the event, not one instant.
 */
export function damageContours(result: SimulationResult, opts: ContourOptions = {}): ContourBand[] {
  const smoothing = opts.smoothing ?? 2;
  const minAreaCells = opts.minAreaCells ?? 2;
  const { nx, ny, dx, x0, y0, crs } = result.grid;
  const wetThreshold = Math.max(0.001, result.options.reportingDepthM ?? 0.005);

  const raw = new Float32Array(nx * ny);
  const arr = result.arrivalTime;
  const vel = result.maxVelocity;
  for (let i = 0; i < nx * ny; i++) {
    const d = result.maxDepth[i];
    const a = arr ? arr[i] : -1;
    const v = vel ? vel[i] : 0;
    const wet = (Number.isFinite(d) && d >= wetThreshold) || (a >= 0 && (d >= 0.0006 || v >= 0.08));
    raw[i] = wet ? Math.max(1, result.damageScore[i] || 0) : NaN;
  }
  const smooth = blur(raw, nx, ny, smoothing);
  // Masked cells must read as *below threshold*, not as "skip me": skipping them leaves the
  // outer edge of the wet footprint open, so the largest band never closes into a ring and
  // silently disappears from the map.
  for (let i = 0; i < smooth.length; i++) if (!Number.isFinite(smooth[i])) smooth[i] = 0;
  const grid: Grid2D = { nx, ny, v: smooth };

  // Cell-centre coordinates to metres. Marching squares works in cell-index space.
  const toLngLat = (cx: number, cy: number): number[] => {
    // cx/cy are in "cell corner" units; the value at index i is the centre of cell i.
    const x = x0 + (cx - 0.5) * dx;
    const y = y0 + (cy - 0.5) * dx;
    const ll = unproject(x, y, crs);
    return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
  };

  const out: ContourBand[] = [];
  for (const band of BAND_THRESHOLDS) {
    const cellRings = stitch(marchingSquares(grid, band.min)).filter(
      (r) => Math.abs(ringArea(r)) >= minAreaCells,
    );
    if (cellRings.length === 0) continue;

    // Area is measured in CELL units here — converting to degrees first would measure
    // square degrees, which are ~1e-9 m² and make every band look empty.
    const areaCells = cellRings.reduce((n, r) => n + Math.abs(ringArea(r)), 0);
    // Smooth rings with Chaikin corner-cutting so water boundaries are organic & fluent
    const ordered = cellRings
      .map((r) => ({ r: smoothRing(r, 2), a: Math.abs(ringArea(r)) }))
      .sort((p, q) => q.a - p.a)
      .map((p) => p.r.map(([x, y]) => toLngLat(x, y)));

    out.push({
      id: band.id,
      min: band.min,
      colour: band.colour,
      polygons: ordered.map((r) => [r]),
      areaM2: areaCells * dx * dx,
    });
  }
  return out;
}

/**
 * Smoothed damage-score field, for painting as a continuous heat-map raster.
 *
 * Exposed separately from the contours because the map wants the interpolated value at every
 * cell, not just the iso-lines. Cells with no water come back as 0 (transparent).
 */
export function damageScoreField(result: SimulationResult, smoothing = 2): Float32Array {
  const { nx, ny } = result.grid;
  const wetThreshold = Math.max(0.001, result.options.reportingDepthM ?? 0.005);
  const raw = new Float32Array(nx * ny);
  const arr = result.arrivalTime;
  const vel = result.maxVelocity;
  for (let i = 0; i < nx * ny; i++) {
    const d = result.maxDepth[i];
    const a = arr ? arr[i] : -1;
    const v = vel ? vel[i] : 0;
    const wet = (Number.isFinite(d) && d >= wetThreshold) || (a >= 0 && (d >= 0.0005 || v >= 0.04));
    if (wet) {
      const score = result.damageScore ? (result.damageScore[i] || 0) : 0;
      // Guarantee base value so outer shallow sheet flow is tinted with soft water cyan
      raw[i] = Math.max(3.0, score);
    } else {
      raw[i] = 0;
    }
  }
  return blurZeroPadded(raw, nx, ny, Math.max(1, smoothing));
}

/** Total contoured area per band in m², for the legend. */
export function contourAreas(bands: ContourBand[]): Record<BandId, number> {
  const res: Record<BandId, number> = { low: 0, medium: 0, high: 0 };
  for (const b of bands) res[b.id] = b.areaM2;
  return res;
}

/**
 * Smooth, organic water extent perimeter (shoreline).
 * Uses hydraulic flow path connectivity and sub-cell marching squares so the flood boundary
 * forms a contiguous, merged polygon centered at the tank without isolated floating puddle rings.
 */
/**
 * Fluent water extent shoreline contour(s) wrapping the flood footprint.
 * Traces the natural hydraulic shoreline of where water travelled and accumulated across terrain.
 */
export function waterExtentRings(result: SimulationResult): number[][][] {
  const { nx, ny, dx, x0, y0, crs } = result.grid;
  const thresh = Math.max(0.001, result.options.reportingDepthM ?? 0.005);
  const arr = result.arrivalTime;
  const vel = result.maxVelocity;

  // 1. Mark cells that received water: either depth >= threshold, active sheet flow transit, or classified damage
  const raw = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const d = result.maxDepth[i];
    const a = arr ? arr[i] : -1;
    const v = vel ? vel[i] : 0;
    const s = result.damageScore ? result.damageScore[i] : 0;
    const wet = (Number.isFinite(d) && d >= thresh) || (a >= 0 && (d >= 0.0005 || v >= 0.05)) || s > 0;
    raw[i] = wet ? Math.max(1, s > 0 ? s : 1) : 0;
  }

  // 2. Morphological closing (3x3 dilation then erosion) to bridge thin supercritical flow paths
  // down steep rocky slopes and seal 1-cell gaps along drainage channels.
  const dilated = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      let maxVal = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ny) continue;
        const nRow = yy * nx;
        for (let dx_ = -1; dx_ <= 1; dx_++) {
          const xx = x + dx_;
          if (xx < 0 || xx >= nx) continue;
          const val = raw[nRow + xx];
          if (val > maxVal) maxVal = val;
        }
      }
      dilated[row + x] = maxVal;
    }
  }

  const closed = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      if (raw[row + x] === 0 && dilated[row + x] === 0) continue;
      let minVal = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ny) continue;
        const nRow = yy * nx;
        for (let dx_ = -1; dx_ <= 1; dx_++) {
          const xx = x + dx_;
          if (xx < 0 || xx >= nx) continue;
          const val = dilated[nRow + xx];
          if (val < minVal) minVal = val;
        }
      }
      closed[row + x] = minVal > 0 && Number.isFinite(minVal) ? minVal : 0;
    }
  }

  // 3. Gaussian blur for continuous, fluent organic water boundary
  const smoothed = blur(closed, nx, ny, 2);
  for (let i = 0; i < smoothed.length; i++) if (!Number.isFinite(smoothed[i])) smoothed[i] = 0;
  const grid: Grid2D = { nx, ny, v: smoothed };

  const toLngLat = (px: number, py: number): [number, number] => {
    const x = x0 + (px - 0.5) * dx;
    const y = y0 + (py - 0.5) * dx;
    const ll = unproject(x, y, crs);
    return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
  };

  const minRingArea = Math.max(3, Math.ceil(300 / (dx * dx)));
  const rawRings = stitch(marchingSquares(grid, 0.5));
  const smoothRings = rawRings
    .filter((r) => Math.abs(ringArea(r)) >= minRingArea)
    .sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))
    .map((r) => smoothRing(r, 2).map(([cx_, cy_]) => toLngLat(cx_, cy_)));

  return smoothRings;
}

export interface Isochrone {
  timeS: number;
  label: string;
  shortLabel: string;
  colour: string;
  lines: [number, number][][];
  labelPoints: { lng: number; lat: number; label: string; colour: string }[];
}

/**
 * Flood Arrival Isochrones (Progressive Time Waves).
 * Generates smooth wavefront contour lines (e.g. 5 min, 15 min, 30 min, 1 hr)
 * showing the spatial progression of the flood over time.
 * Spacing between isochrones directly communicates flood velocity:
 * wide spacing = rapid surge down steep mountain valleys;
 * dense spacing = slow pooling in urban depressions.
 */
export function arrivalIsochrones(result: SimulationResult): Isochrone[] {
  const { nx, ny, dx, x0, y0, crs } = result.grid;
  const arr = result.arrivalTime;
  if (!arr || arr.length !== nx * ny) return [];

  // Find min and max arrival times among traversed wet cells
  let minT = Infinity;
  let maxT = 0;
  for (let i = 0; i < nx * ny; i++) {
    const t = arr[i];
    if (t >= 0 && Number.isFinite(t)) {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
  }

  if (!Number.isFinite(minT) || maxT <= 0 || maxT - minT < 10) return [];

  // Determine intuitive, clean time intervals
  const rawIntervals: number[] = [];
  if (maxT <= 600) {
    rawIntervals.push(60, 180, 300, 480, 600);
  } else if (maxT <= 1800) {
    rawIntervals.push(120, 300, 600, 900, 1200, 1800);
  } else if (maxT <= 3600) {
    rawIntervals.push(300, 600, 900, 1800, 2700, 3600);
  } else if (maxT <= 7200) {
    rawIntervals.push(300, 900, 1800, 3600, 5400, 7200);
  } else {
    rawIntervals.push(900, 1800, 3600, 7200, 10800, 14400);
  }

  const intervals = rawIntervals.filter((t) => t >= minT + 15 && t <= maxT * 0.98);
  if (intervals.length === 0) {
    intervals.push(minT + 0.25 * (maxT - minT), minT + 0.5 * (maxT - minT), minT + 0.75 * (maxT - minT));
  }

  // Create smooth arrival time field
  const rawTime = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    rawTime[i] = arr[i] >= 0 ? arr[i] : NaN;
  }
  const smoothTime = blur(rawTime, nx, ny, 1);
  const grid: Grid2D = { nx, ny, v: smoothTime };

  const toLngLat = (px: number, py: number): [number, number] => {
    const x = x0 + (px - 0.5) * dx;
    const y = y0 + (py - 0.5) * dx;
    const ll = unproject(x, y, crs);
    return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
  };

  const fmtShort = (tS: number) => {
    if (tS < 60) return `${Math.round(tS)}s`;
    if (tS < 3600) return `${Math.round(tS / 60)} min`;
    const h = tS / 3600;
    return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
  };

  const fmtFull = (tS: number) => {
    if (tS < 60) return `T + ${Math.round(tS)} sec`;
    if (tS < 3600) return `T + ${Math.round(tS / 60)} min`;
    const h = Math.floor(tS / 3600);
    const m = Math.round((tS % 3600) / 60);
    return m > 0 ? `T + ${h}h ${m}m` : `T + ${h} hr`;
  };

  // Color ramp from rapid warning amber to electric cyan to indigo
  const pickColour = (tS: number) => {
    const frac = Math.max(0, Math.min(1, (tS - minT) / Math.max(1, maxT - minT)));
    if (frac < 0.25) return "#fbbf24"; // early warning amber
    if (frac < 0.55) return "#38bdf8"; // electric cyan
    if (frac < 0.8) return "#60a5fa";  // blue
    return "#a78bfa";                 // violet / extended
  };

  const out: Isochrone[] = [];

  for (const tTarget of intervals) {
    const rawSegs = marchingSquares(grid, tTarget);
    if (rawSegs.length === 0) continue;
    const stitched = stitchLines(rawSegs);

    const validLines = stitched.filter((l) => l.length >= 3);
    if (validLines.length === 0) continue;

    const colour = pickColour(tTarget);
    const label = fmtFull(tTarget);
    const shortLabel = fmtShort(tTarget);

    const smoothedLines: [number, number][][] = [];
    const labelPoints: { lng: number; lat: number; label: string; colour: string }[] = [];

    for (const rawLine of validLines) {
      const isClosed =
        rawLine.length >= 4 &&
        Math.hypot(rawLine[0][0] - rawLine[rawLine.length - 1][0], rawLine[0][1] - rawLine[rawLine.length - 1][1]) < 1e-3;
      const smooth = smoothLine(rawLine, 2, isClosed);
      const coordsLL: [number, number][] = smooth.map(([cx_, cy_]) => toLngLat(cx_, cy_));
      smoothedLines.push(coordsLL);

      // Add label badge at line midpoint for lines with reasonable length
      if (coordsLL.length >= 4) {
        const midIdx = Math.floor(coordsLL.length / 2);
        labelPoints.push({
          lng: coordsLL[midIdx][0],
          lat: coordsLL[midIdx][1],
          label: shortLabel,
          colour,
        });
      }
    }

    if (smoothedLines.length > 0) {
      out.push({
        timeS: tTarget,
        label,
        shortLabel,
        colour,
        lines: smoothedLines,
        labelPoints,
      });
    }
  }

  return out;
}
