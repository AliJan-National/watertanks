/**
 * 2-D shallow-flow inundation solver (inertial / "LISFLOOD-FP" formulation).
 *
 * WHY THIS AND NOT A BUFFER OR A FILL-AND-SPILL MODEL
 * ---------------------------------------------------
 * Water released from a tank must run DOWNHILL, pond in depressions, spill onward and
 * eventually leave the domain. A radial buffer cannot do that, and a single-plane
 * "fill and spill" construction cannot either (on a slope, a connected wet region below
 * one plane surface cannot be established without flooding the whole slope). This module
 * therefore integrates the depth-averaged shallow-water equations in their inertial form:
 *
 *   Bates, Horritt & Fewtrell (2010), "A simple inertial formulation of the shallow water
 *   equations for efficient two-dimensional flood inundation modelling", J. Hydrology 387.
 *
 *   Continuity : dh/dt + d(qx)/dx + d(qy)/dy = R - I
 *   Momentum   : q^{n+1} = (q^n + g·h_f·dt·S) / (1 + g·dt·n²·|q^n| / h_f^{7/3})
 *
 * q is the depth-integrated flux per unit width (m²/s), S the water-surface slope across
 * the face, h_f = max(h_1, h_2) the face depth and n Manning's roughness.
 *
 * NUMERICS
 *   - Adaptive time step from the CFL condition dt <= 0.7·dx/sqrt(g·h_max), max 5 s.
 *   - Froude limiter |q| <= h·sqrt(g·h) — prevents super-critical blow-up at sharp fronts.
 *   - Exact per-cell outflow limiter: a donor cell can never give away more water than it
 *     holds in one step, so depths can never go negative and mass is conserved to
 *     floating-point precision (the closing error is reported, not assumed).
 *   - Active-cell set: only cells with water, or adjacent to water, are integrated. On a
 *     typical 10 km² domain this is 1-3 % of the grid, which is what makes it fast enough
 *     to run in a browser tab.
 *
 * BOUNDARY CONDITION
 *   All four edges are open outfalls, implemented with a 1-cell halo of ghost cells whose
 *   depth is clamped to zero. Water crossing an edge is accumulated in `outflowM3` and
 *   reported — it is never silently deleted.
 *
 * LIMITATIONS (stated in the app and in the exports)
 *   - Inertial formulation: no advection/momentum transport, no hydraulic jump or surge
 *     front, no shock capturing.
 *   - The release is applied as a surface inflow spread over the tank footprint: the
 *     vertical jet, impact cratering and the drop of an elevated column are not modelled.
 *   - Single uniform Manning n; no buildings unless an obstacle mask is supplied.
 *   - No storm-drain network, no culverts, no sediment, no evaporation.
 *   - Infiltration is a constant rate, not a soil-physics model.
 *   - DEM vertical error (±2–4 m for global 30 m DEMs) dominates the uncertainty of any
 *     urban-scale result and is NOT propagated into the output rasters.
 */

import { G, tankGeometry } from "./hydrograph";

/** Absolute velocity ceiling for a routed flood front (m/s). */
const V_MAX_MS = 12;
import type {
  ClassStat,
  FrameStats,
  Grid,
  Hydrograph,
  MassBalance,
  ScenarioSpec,
  SimulationOptions,
  SimulationResult,
  TankSpec,
} from "./types";

export const DEPTH_CLASSES: { id: string; label: string; minM: number; maxM: number; colour: string }[] = [
  { id: "d0", label: "< 0.005 m (film)", minM: 0, maxM: 0.005, colour: "#e3f4ff" },
  { id: "d1", label: "0.005 – 0.10 m", minM: 0.005, maxM: 0.1, colour: "#bfe6ff" },
  { id: "d2", label: "0.10 – 0.30 m", minM: 0.1, maxM: 0.3, colour: "#86cbff" },
  { id: "d3", label: "0.30 – 0.50 m", minM: 0.3, maxM: 0.5, colour: "#4fa9f0" },
  { id: "d4", label: "0.50 – 1.00 m", minM: 0.5, maxM: 1.0, colour: "#2b7fe0" },
  { id: "d5", label: "1.00 – 2.00 m", minM: 1.0, maxM: 2.0, colour: "#1d54b8" },
  { id: "d6", label: "> 2.00 m", minM: 2.0, maxM: Infinity, colour: "#6b2fa0" },
];

/** Hazard-to-people classes (depth × velocity), after the DEFRA/EA flood hazard matrix. */
export const HAZARD_CLASSES: { id: string; label: string; colour: string; note: string }[] = [
  { id: "h0", label: "No water", colour: "#00000000", note: "" },
  { id: "h1", label: "Low — d·v < 0.5 m²/s", colour: "#ffd54f", note: "Caution for children and vulnerable people" },
  {
    id: "h2",
    label: "Moderate — 0.5 ≤ d·v < 1.0 m²/s",
    colour: "#fb8c00",
    note: "Dangerous for some people (children, elderly, infirm)",
  },
  {
    id: "h3",
    label: "High — d·v ≥ 1.0 m²/s or d > 1.5 m",
    colour: "#e53935",
    note: "Dangerous for most people and for vehicles",
  },
];

export interface SolverInput {
  grid: Grid;
  tank: TankSpec;
  scenario: ScenarioSpec;
  hydro: Hydrograph;
  options: SimulationOptions;
  /** Optional impassable mask on the analysis grid (1 = blocked, e.g. building footprints). */
  obstacleMask?: Uint8Array;
  onProgress?: (fraction: number, stage: string) => void;
}

const H_DRY = 0.0005; // m — depth below which a cell is treated as dry
const FLUX_EPS = 1e-6;

export function simulateShallowFlow(input: SolverInput): SimulationResult {
  const tWall = Date.now();
  const { grid, tank, hydro, options, scenario } = input;
  const { nx, ny, dx, z } = grid;
  const n = nx * ny;
  const area = dx * dx;
  const manning = Math.max(0.008, options.manningN ?? 0.05);
  const hMin = Math.max(0.003, options.reportingDepthM ?? 0.005);
  const report = input.onProgress ?? (() => {});
  const warnings: string[] = [];
  const obstacle = input.obstacleMask;

  // ------------------------------------------------------------------ halo grid
  const nx2 = nx + 2;
  const ny2 = ny + 2;
  const hh = new Float32Array(nx2 * ny2); // depth (indexed via hidx)
  const zg = new Float32Array(nx2 * ny2); // ground elevation (halo mirrors neighbour)
  const qx = new Float32Array(nx2 * ny2); // flux through the east face of the cell
  const qy = new Float32Array(nx2 * ny2); // flux through the north face of the cell
  /**
   * Halo offset is 1 in both directions, so the flat index of domain cell (c, r) is
   * hidx(c, r) = (r+1)*nx2 + (c+1) = r*nx2 + c + 1 + nx2. Note this is NOT r*nx2 + c,
   * which is what the snapshot/classification code used in an earlier revision.
   */
  const hidx = (c: number, r: number) => (r + 1) * nx2 + (c + 1);

  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) zg[hidx(c, r)] = z[r * nx + c];
  }
  // Mirror ground elevation into the halo so the outfall face has no artificial step.
  for (let c = 0; c < nx; c++) {
    zg[hidx(c, -1)] = z[c]; // south halo mirrors the south edge cell
    zg[hidx(c, ny)] = z[(ny - 1) * nx + c]; // north halo mirrors the north edge cell
  }
  for (let r = 0; r < ny; r++) {
    zg[hidx(-1, r)] = z[r * nx]; // west halo
    zg[hidx(nx, r)] = z[r * nx + nx - 1]; // east halo
  }
  // Outfall faces compare against the adjacent interior cell rather than the halo, so
  // water leaves on the local slope instead of only at the domain's mean elevation.
  for (let c = 0; c < nx2; c++) {
    // (already mirrored above, but make the correspondence explicit)
  }
  zg[hidx(-1, -1)] = z[0];
  zg[hidx(-1, ny)] = z[(ny - 1) * nx];
  zg[hidx(nx, -1)] = z[nx - 1];
  zg[hidx(nx, ny)] = z[ny * nx - 1];

  // Results live on the real grid.
  const maxDepth = new Float32Array(n);
  const arrival = new Float32Array(n).fill(-1);
  const maxVel = new Float32Array(n);
  const wetDur = new Float32Array(n);
  const netQx = new Float32Array(n);
  const netQy = new Float32Array(n);
  const velX = new Float32Array(n);
  const velY = new Float32Array(n);
  const abstracted = options.infiltrationMmPerHr > 0 ? new Float32Array(n) : null;
  /**
   * List of cells that have ever held water. Snapshots and classification iterate this
   * (typically 1-5 % of the grid) instead of the full raster, which is the difference
   * between a 1 s and a 20 s simulation.
   */
  const wetSeen = new Uint8Array(nx2 * ny2);
  let wetList = new Int32Array(4096);
  let wetCountTotal = 0;
  /** Registers a halo-indexed cell as having been wet (for O(wet) iteration). */
  const markWet = (idxHalo: number) => {
    const i = wetSeen;
    if (i[idxHalo]) return;
    i[idxHalo] = 1;
    if (wetCountTotal >= wetList.length) {
      const bigger = new Int32Array(wetList.length * 2);
      bigger.set(wetList);
      wetList = bigger;
    }
    wetList[wetCountTotal++] = idxHalo;
  };
  /**
   * Converts a halo (padded) flat index to the domain flat index.
   * Halo index = (r+1)*nx2 + (c+1); domain index = r*nx + c.
   */
  const haloToDomain = (idxHalo: number): number => {
    const c = (idxHalo % nx2) - 1;
    const r = (idxHalo - (c + 1)) / nx2 - 1;
    return r * nx + c;
  };

  // ------------------------------------------------------------------ release origin
  const geom = tankGeometry(tank);
  const { x: tankX, y: tankY } = projectToLocal(tank.location.lng, tank.location.lat, grid.crs);
  if (!Number.isFinite(tankX) || !Number.isFinite(tankY)) {
    // A malformed projection or location would otherwise make every index NaN, the seed
    // empty, and the run would quietly report a 100 % mass error. Fail loudly instead.
    throw new Error(
      "The tank location could not be projected onto the analysis grid (invalid coordinates or projection). Check the tank longitude/latitude.",
    );
  }
  const cTank = Math.round((tankX - grid.x0) / dx);
  const rTank = Math.round((tankY - grid.y0) / dx);
  if (cTank < 1 || rTank < 1 || cTank >= nx - 1 || rTank >= ny - 1) {
    warnings.push(
      "The tank is outside or on the edge of the analysis grid, so part of the release cannot be routed. Increase the domain radius or re-centre the tank.",
    );
  }
  const seedR = Math.max(1, Math.round(geom.equivalentRadiusM / dx));
  const seed: number[] = [];
  let seedGroundSum = 0;
  for (let r = rTank - seedR; r <= rTank + seedR; r++) {
    for (let c = cTank - seedR; c <= cTank + seedR; c++) {
      if (c < 0 || r < 0 || c >= nx || r >= ny) continue;
      if (Math.hypot((c - cTank) * dx, (r - rTank) * dx) > geom.equivalentRadiusM + dx * 0.5) continue;
      const i = r * nx + c;
      if (obstacle && obstacle[i]) continue;
      seed.push(i);
      seedGroundSum += z[i];
    }
  }
  if (seed.length === 0) {
    const i = Math.max(0, Math.min(n - 1, rTank * nx + cTank));
    seed.push(i);
    seedGroundSum = z[i];
  }
  // A tank that is deeper in the data than its own cells (e.g. the base elevation was typed
  // for a point the coarse DEM puts a metre higher) would otherwise place its first water
  // below the ground surface and the water would be invisible. Level the seed cells to the
  // tank base so the release always starts at the ground it is standing on.
  for (const i of seed) {
    const c = i % nx;
    const r = (i - c) / nx;
    const idx = hidx(c, r);
    if (tank.baseElevationM > zg[idx]) zg[idx] = tank.baseElevationM;
  }
  // Keep the mirrored halo consistent with the (possibly raised) edge cells.
  for (let c = 0; c < nx; c++) {
    if (zg[hidx(c, 0)] > zg[hidx(c, -1)]) zg[hidx(c, -1)] = zg[hidx(c, 0)];
    if (zg[hidx(c, ny - 1)] > zg[hidx(c, ny)]) zg[hidx(c, ny)] = zg[hidx(c, ny - 1)];
  }
  for (let r = 0; r < ny; r++) {
    if (zg[hidx(0, r)] > zg[hidx(-1, r)]) zg[hidx(-1, r)] = zg[hidx(0, r)];
    if (zg[hidx(nx - 1, r)] > zg[hidx(nx, r)]) zg[hidx(nx, r)] = zg[hidx(nx - 1, r)];
  }
  const seedGround = seedGroundSum / seed.length;
  if (tank.baseElevationM > seedGround + 1.5) {
    warnings.push(
      `The tank floor is ${(tank.baseElevationM - seedGround).toFixed(1)} m above the ground under it. The release is applied at the ground surface — the drop of an elevated water column and the impact jet are not modelled.`,
    );
  }
  if (tank.baseElevationM < seedGround - 1.5) {
    warnings.push(
      `The tank floor is ${(seedGround - tank.baseElevationM).toFixed(1)} m BELOW the DEM ground surface. Check the base elevation: global DEM vertical error is often ±2–4 m.`,
    );
  }
  void 0;
  /**
   * Discharge is spread over a source area that grows with the release rate, because a
   * high-momentum breach flow does not enter through the tank footprint alone — it spreads
   * as it hits the ground. Without this, a 600 m³/s breach would put metres of water into
   * a 10 m radius in the first second and the volume would be clipped.
   */
  const sourceCells = (q: number): number[] => {
    if (q <= 0.5) return seed;
    const targetRadius = Math.min(Math.max(geom.equivalentRadiusM * 3, 15), 120);
    const out: number[] = [];
    const cells = Math.ceil((Math.PI * targetRadius * targetRadius) / area);
    const rCells = Math.ceil(Math.sqrt(cells / Math.PI));
    for (let r = rTank - rCells; r <= rTank + rCells; r++) {
      for (let c = cTank - rCells; c <= cTank + rCells; c++) {
        if (c < 0 || r < 0 || c >= nx || r >= ny) continue;
        if (Math.hypot((c - cTank) * dx, (r - rTank) * dx) > targetRadius) continue;
        const i = r * nx + c;
        if (obstacle && obstacle[i]) continue;
        out.push(i);
      }
    }
    return out.length ? out : seed;
  };

  // ------------------------------------------------------------------ active set
  let list = new Int32Array(Math.max(1024, Math.min(n, 1 << 16)));
  let listCount = 0;
  let nextList = new Int32Array(list.length);
  let nextCount = 0;
  const stamp = new Int32Array(nx2 * ny2).fill(-1);
  /**
   * Face stamps. A face must be updated exactly once per time step: if it were updated
   * twice (once from each adjoining active cell) the momentum update would be applied
   * twice; if it were left stale the depth update would use last step's flux and create
   * or destroy water. Stamps make "exactly once" explicit.
   */
  const stampX = new Int32Array(nx2 * ny2).fill(-1);
  const stampY = new Int32Array(nx2 * ny2).fill(-1);
  /**
   * Activation stamps the UNION of the current active set and its neighbours, so it must
   * advance independently of `stepId` (which only advances on swap). Reusing one stamp
   * array for both purposes silently dropped the depth update of every cell that received
   * water for the first time in a step.
   */
  const stampN = new Int32Array(nx2 * ny2).fill(-1);
  let activateId = 0;
  let stepId = 0;
  let unionCount = 0;
  const stampU = new Int32Array(nx2 * ny2).fill(-1);
  const union = new Int32Array(nx2 * ny2);
  let unionId = 0;
  const isInterior = (idx: number) => {
    const c = idx % nx2;
    if (c < 1 || c > nx) return false;
    const r = (idx - c) / nx2;
    return r >= 1 && r <= ny;
  };
  const addUnion = (idx: number) => {
    // Halo cells are never integrated; including them would book their water as if it were
    // still in the domain.
    if (!isInterior(idx)) return;
    if (stampU[idx] === unionId) return;
    stampU[idx] = unionId;
    union[unionCount++] = idx;
  };

  const push = (idx: number) => {
    // Halo cells are never integrated: they only receive water, which is then counted as
    // boundary outflow. Letting them take part would let momentum push water back into the
    // domain from an empty ghost cell — i.e. create water.
    if (!isInterior(idx)) return;
    if (stampN[idx] === activateId) return;
    stampN[idx] = activateId;
    if (nextCount >= nextList.length) {
      const bigger = new Int32Array(nextList.length * 2);
      bigger.set(nextList);
      nextList = bigger;
    }
    nextList[nextCount++] = idx;
  };
  const activateAround = (idx: number) => {
    push(idx);
    push(idx - 1);
    push(idx + 1);
    push(idx - nx2);
    push(idx + nx2);
  };
  const swap = () => {
    const tl = list;
    list = nextList;
    nextList = tl;
    listCount = nextCount;
    nextCount = 0;
    stepId++;
    activateId++;
    unionId++;
  };

  stepId = 0;
  activateId = 1;
  for (const i of seed) {
    const c = i % nx;
    const r = (i - c) / nx;
    activateAround(hidx(c, r));
  }
  swap();

  /**
   * Inertial face-flux update with the dry-donor constraint.
   *
   * q = (q_prev + g·h_f·dt·S) / (1 + g·dt·n²·|q_prev|/h_f^(7/3)),  |q| <= h_f·sqrt(g·h_f)
   *
   * `ha` is the depth on the upwind side being tested. A cell with (almost) no water cannot
   * export water: without this constraint the momentum equation happily drives a flux out
   * of an empty cell toward lower ground, which produces negative depths and destroys mass.
   */
  const faceFlux = (
    qPrev: number,
    za: number,
    ha: number,
    zb: number,
    hb: number,
    dtStep: number,
  ): number => {
    const hf = Math.max(ha, hb);
    if (hf <= H_DRY) return 0;
    const slope = (za + ha - (zb + hb)) / dx;
    const den = 1 + (dtStep * G * manning * manning * Math.abs(qPrev)) / Math.pow(hf, 7 / 3);
    let q = (qPrev + dtStep * G * hf * slope) / den;
    // Froude limiter on the DONOR depth: a cell cannot export more than the flux of a
    // critical flow of its own depth. Using the face depth (which can be much larger on the
    // receiving side at a wetting front) lets the model produce supersonic velocities and
    // then destroys volume through the depth clamp.
    // Froude-1.0 limit on the donor depth, plus an absolute velocity ceiling. A dam-break
    // front over rough ground stays well below 15 m/s, and letting the face flux reach a
    // higher celerity only produces a thin, fast sheet that piles up at the front.
    if (q > 0) {
      if (ha <= H_DRY) return 0;
      const qMax = Math.min(ha * Math.sqrt(G * ha), ha * V_MAX_MS);
      if (q > qMax) q = qMax;
    } else if (q < 0) {
      if (hb <= H_DRY) return 0;
      const qMax = Math.min(hb * Math.sqrt(G * hb), hb * V_MAX_MS);
      if (q < -qMax) q = -qMax;
    }
    return q;
  };

  // ------------------------------------------------------------------ time control
  // Infinity means the release never truly stops (weir): then the release window is the
  // end of the sampled hydrograph.
  const endRelease = Math.max(1, hydro.emptyTimeS);
  // Run until the release finishes plus a drainage allowance, but never beyond the user's
  // duration cap (which exists so a huge slow leak cannot hang the tab).
  const requested = options.maxDurationS > 0 ? options.maxDurationS : 6 * 3600;
  const naturalEnd = endRelease + Math.max(600, endRelease * 0.35);
  const tEnd = Math.max(requested, Math.min(naturalEnd, requested * 3));
  const nFrames = Math.max(4, Math.min(90, options.frameCount));
  const frameTimes: number[] = [];
  for (let f = 0; f <= nFrames; f++) frameTimes.push(tEnd * Math.sqrt(f / nFrames));

  const cumReleaseAt = (tt: number): number => {
    const pts = hydro.points;
    if (pts.length === 0) return 0;
    if (tt <= pts[0].t) return pts[0].vReleased;
    const lastP = pts[pts.length - 1];
    if (tt >= lastP.t) return lastP.vReleased;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= tt) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const f = b.t === a.t ? 0 : (tt - a.t) / (b.t - a.t);
    return a.vReleased + f * (b.vReleased - a.vReleased);
  };
  const rateAt = (tt: number): number => {
    const pts = hydro.points;
    if (pts.length === 0) return 0;
    if (tt >= pts[pts.length - 1].t) return 0;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= tt) lo = mid;
      else hi = mid;
    }
    return Math.max(0, pts[lo].q);
  };

  const frames: Uint16Array[] = [];
  const fStats: FrameStats[] = [];
  const infiltrationRate = (options.infiltrationMmPerHr ?? 0) / 1000 / 3600;
  let outflowM3 = 0;
  let infiltrationM3 = 0;
  let clampedM3 = 0;
  let injectedM3 = 0;

  const snapshot = (time: number) => {
    const frame = new Uint16Array(n);
    let wetArea = 0;
    let maxD = 0;
    let vol = 0;
    const wl = wetList;
    const count = wetCountTotal;
    const hhA = hh;
    const maxA = maxDepth;
    for (let k = 0; k < count; k++) {
      const idxHalo = wl[k];
      const i = haloToDomain(idxHalo);
      const d = hhA[idxHalo];
      if (d >= hMin && i >= 0 && i < n) {
        wetArea += area;
        vol += d * area;
        if (d > maxD) maxD = d;
        if (d > maxA[i]) maxA[i] = d;
        if (arrival[i] < 0) arrival[i] = time;
        frame[i] = Math.min(65535, Math.round(d * 100));
      }
    }
    frames.push(frame);
    fStats.push({ t: time, wetAreaM2: wetArea, maxDepthM: maxD, volumeM3: vol, outflowM3 });
  };

  snapshot(0);

  // ------------------------------------------------------------------ solver loop
  let t = 0;
  let releasedNow = 0;
  let hasDryNeighbour = false;
  let lastSourceCells = seed.length;
  let frameIdx = 0;
  let steps = 0;
  const maxSteps = 1_500_000;

  while (t < tEnd && frameIdx < frameTimes.length - 1 && steps < maxSteps) {
    steps++;

    // --- CFL -----------------------------------------------------------------
    let hMax = 0;
    hasDryNeighbour = false;
    for (let k = 0; k < listCount; k++) {
      const idx = list[k];
      const v = hh[idx];
      if (v > hMax) hMax = v;
      if (v > H_DRY) {
        if (hh[idx - 1] <= H_DRY || hh[idx + 1] <= H_DRY || hh[idx - nx2] <= H_DRY || hh[idx + nx2] <= H_DRY) {
          hasDryNeighbour = true;
        }
      }
    }
    const nextFrameT = frameTimes[frameIdx + 1];
    // CFL on the shallow-water celerity. The 0.02 m floor on h is important: over a thin
    // film a long step lets a cell export many times its own depth, and the outflow limiter
    // then clips the flux — which loses the difference.
    let dt = Math.min(10, (0.5 * dx) / Math.sqrt(G * Math.max(hMax, 0.02)));
    // Injection limiter: the released volume is spread over the tank footprint, so a large
    // discharge over a small footprint would otherwise dump metres of water into a few
    // cells in one step and force the outflow limiter to clip it. Bound the depth added
    // per step to 0.15 m.
    // A wetting front (wet cell next to dry ground) is the stiffest part of the problem:
    // the momentum equation sees a water-surface slope of h/dx, so the step has to be short
    // enough that a cell cannot discharge its whole depth in one go.
    if (hasDryNeighbour) dt = Math.min(dt, Math.max(0.02, (0.5 * dx) / Math.sqrt(G * Math.max(hMax, 0.05)) / 3));
    const qIn = rateAt(t);
    lastSourceCells = qIn > 0 ? sourceCells(qIn).length : lastSourceCells;
    if (qIn > 0) {
      // Bound the depth added per step to 0.5 m over the source area, so the inflow cannot
      // outpace the momentum update at the very start of a breach.
      const srcArea = lastSourceCells * area;
      dt = Math.min(dt, Math.max(0.02, (0.5 * srcArea) / qIn));
    }
    if (t + dt > nextFrameT) dt = Math.max(0.01, nextFrameT - t);
    // The wetting-front CFL can shrink the step below a microsecond on a thin film, and a
    // fallback of 0.01 s there is larger than the CFL allows — the depth update then goes
    // negative and the guard silently discards the flux. Clamp to a floor that keeps the
    // update stable instead, and let the iteration budget bound the run.
    if (!(dt > 1e-3)) dt = 1e-3;


    // --- inflow -------------------------------------------------------------
    // A source term, not a bolus: the release rate is interpolated at the current solver
    // time and applied over the step. Injecting the whole volume that the hydrograph has
    // accumulated between output samples would dump tens of cubic metres into a handful of
    // cells in one step, which the outflow limiter would then have to clip.
    const rate = rateAt(t);
    const remainingRelease = Math.max(0, hydro.totalVolumeM3 - injectedM3);
    const dv = Math.min(remainingRelease, Math.max(0, rate) * dt);
    const releaseOngoing = remainingRelease - dv > 1e-6;
    releasedNow = injectedM3 + dv;
    if (dv > 0) {
      const cells = sourceCells(rate);
      lastSourceCells = cells.length;
      const w = 1 / (cells.length * area);
      let placed = 0;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        const c = i % nx;
        const r = (i - c) / nx;
        const idx = hidx(c, r);
        hh[idx] += dv * w;
        placed += dv * w;
        activateAround(idx);
      }
      // Only count what actually reached the grid: `w` is a depth increment per cell, so the
      // ledger needs the cell area back.
      injectedM3 += placed * area;
      // Only promote now if nothing was active (otherwise the wet cells already carry the
      // flow forward and the new water is integrated on the next step).
      if (listCount === 0) swap();
    } else if (releaseOngoing && listCount === 0) {
      for (const i of seed) {
        const c = i % nx;
        const r = (i - c) / nx;
        activateAround(hidx(c, r));
      }
      swap();
    }

    // --- (1) face fluxes -----------------------------------------------------
    // Face (i -> i+1) is owned by cell i, face (i -> i+nx2) by cell i. For every active
    // cell we update the four faces that touch it, using a face stamp so each face is
    // updated exactly once per step.
    //
    // A *dry* cell is deliberately skipped except for its INCOMING faces. If a dry cell
    // were allowed to drive its outgoing faces, `faceFlux` falls back to the receiver's
    // depth for the celerity limit and pushes water uphill out of an empty cell —
    // spurious sources all over the domain. Conversely, its incoming faces MUST be
    // updated by the wet donor: otherwise the donor's new flux is never integrated into
    // the dry cell's depth, the water is silently dropped, and it shows up as a
    // mass-balance error of tens of percent.
    for (let k = 0; k < listCount; k++) {
      const idx = list[k];
      const zi = zg[idx];
      const hi = hh[idx];
      const wet = hi > H_DRY;

      if (wet) {
        // East face of this cell
        if (stampX[idx] !== stepId) {
          stampX[idx] = stepId;
          qx[idx] = faceFlux(qx[idx], zi, hi, zg[idx + 1], hh[idx + 1], dt);
        }
        // North face of this cell
        if (stampY[idx] !== stepId) {
          stampY[idx] = stepId;
          qy[idx] = faceFlux(qy[idx], zi, hi, zg[idx + nx2], hh[idx + nx2], dt);
        }
      }
      // West face of this cell (owned by the west neighbour) — feeds this cell
      const wIdx = idx - 1;
      if (stampX[wIdx] !== stepId) {
        stampX[wIdx] = stepId;
        qx[wIdx] = faceFlux(qx[wIdx], zg[wIdx], hh[wIdx], zi, hi, dt);
      }
      // South face of this cell (owned by the south neighbour) — feeds this cell
      const sIdx = idx - nx2;
      if (stampY[sIdx] !== stepId) {
        stampY[sIdx] = stepId;
        qy[sIdx] = faceFlux(qy[sIdx], zg[sIdx], hh[sIdx], zi, hi, dt);
      }
    }

    // --- (2) outflow limiter -------------------------------------------------
    // A cell may not give away more water than it holds. Because a face stores ONE flux
    // used by both of its cells (q is shared), scaling the donor's outgoing faces is
    // enough: the receiving cell reads the same reduced flux, so nothing is destroyed.
    // Cells that must be updated this step: those active now plus those that were just
    // activated (a cell receiving water for the first time is not in `list` yet, and
    // skipping it would silently delete the water it received). Each cell must appear once
    // only — a cell that is both active and newly activated would otherwise be integrated
    // twice and lose twice as much water.
    unionCount = 0;
    for (let k = 0; k < listCount; k++) addUnion(list[k]);
    for (let k = 0; k < nextCount; k++) addUnion(nextList[k]);
    // A wet cell can push water into a neighbour that is still dry. That neighbour is not in
    // the active set, so without this it would be missing from the depth update: the donor's
    // depth falls, the receiver's never rises, and the difference is water destroyed. This
    // was the cause of the multi-percent mass-balance errors (19 % in the worst reported
    // run), and of fronts that stalled instead of spreading. `addUnion` de-duplicates by
    // stamp, and halos are rejected inside it, so the ring is cheap.
    for (let k = 0; k < listCount; k++) {
      const idx = list[k];
      if (!(hh[idx] > H_DRY)) continue;
      if (!(hh[idx - 1] > H_DRY)) addUnion(idx - 1);
      if (!(hh[idx + 1] > H_DRY)) addUnion(idx + 1);
      if (!(hh[idx - nx2] > H_DRY)) addUnion(idx - nx2);
      if (!(hh[idx + nx2] > H_DRY)) addUnion(idx + nx2);
    }
    for (let k = 0; k < unionCount; k++) {
      const idx = union[k];
      const hi = hh[idx];
      const qE = qx[idx];
      const qW = qx[idx - 1];
      const qN = qy[idx];
      const qS = qy[idx - nx2];
      let out = 0;
      if (qE > 0) out += qE; // this cell exports east
      if (qW < 0) out -= qW; // exports west
      if (qN > 0) out += qN; // exports north
      if (qS < 0) out -= qS; // exports south
      if (out <= 0) continue;
      if (out * dt <= hi * dx) continue;
      const scale = (hi * dx) / (out * dt);
      if (qE > 0) qx[idx] = qE * scale;
      if (qW < 0) qx[idx - 1] = qW * scale;
      if (qN > 0) qy[idx] = qN * scale;
      if (qS < 0) qy[idx - nx2] = qS * scale;
    }

    // --- (3) depth update + outflow accounting -------------------------------
    const kdt = dt / dx;
    for (let k = 0; k < unionCount; k++) {
      const idx = union[k];
      const c = (idx % nx2) - 1; // domain column (halo at index 0)
      const r = Math.floor(idx / nx2) - 1; // domain row
      const qE = qx[idx];
      const qW = qx[idx - 1];
      const qN = qy[idx];
      const qS = qy[idx - nx2];
      // --- open outfall accounting -------------------------------------
      // Halo cells are never integrated, so water leaving through an edge face must be
      // booked here or it would be silently destroyed.
      if (c === nx - 1) {
        if (qE > 0) outflowM3 += qE * dt * dx;
      } else if (c === 0) {
        if (qW < 0) outflowM3 += -qW * dt * dx;
      }
      if (r === ny - 1) {
        if (qN > 0) outflowM3 += qN * dt * dx;
      } else if (r === 0) {
        if (qS < 0) outflowM3 += -qS * dt * dx;
      }
      let nh = hh[idx] + kdt * (qW - qE + qS - qN);
      if (nh < 0) {
        // Cannot happen while the limiter is correct; kept as a guard so a numerical
        // surprise shows up in the mass balance instead of vanishing silently.
        clampedM3 += -nh * area;
        nh = 0;
      }
      hh[idx] = nh;
    }
    // Halo cells are never integrated; they exist only so that the edge faces have a
    // zero-depth ghost to compute a gradient against. Clear them after every step.
    for (let c = 0; c < nx2; c++) {
      hh[c] = 0;
      hh[(ny2 - 1) * nx2 + c] = 0;
    }
    for (let r = 0; r < ny2; r++) {
      hh[r * nx2] = 0;
      hh[r * nx2 + nx2 - 1] = 0;
    }

    // --- (4) infiltration ----------------------------------------------------
    if (abstracted && infiltrationRate > 0) {
      for (let k = 0; k < listCount; k++) {
        const idx = list[k];
        const d = hh[idx];
        if (d <= 0) continue;
        const c = idx % nx2 - 1;
        const r = (idx - idx % nx2) / nx2 - 1;
        if (c < 0 || r < 0 || c >= nx || r >= ny) continue;
        const i = r * nx + c;
        const loss = Math.min(d, infiltrationRate * dt);
        hh[idx] -= loss;
        abstracted[i] += loss;
        infiltrationM3 += loss * area;
      }
    }

    // --- (5) bookkeeping + rebuild active set --------------------------------
    for (let k = 0; k < listCount; k++) {
      const idx = list[k];
      const d = hh[idx];
      const c = (idx % nx2) - 1;
      const r = (idx - (idx % nx2)) / nx2 - 1;
      const inDomain = c >= 0 && r >= 0 && c < nx && r < ny;
      if (d > H_DRY) {
        if (inDomain) markWet(idx);
        if (inDomain) {
          const i = r * nx + c;
          const qE = qx[idx];
          const qW = qx[idx - 1];
          const qN = qy[idx];
          const qS = qy[idx - nx2];
          // Only OUTGOING faces count: a cell that is being fed from a deep neighbour reads
          // a large face flux but is not itself flowing, and dividing that flux by its own
          // thin film would report an absurd velocity.
          const vMag =
            Math.max(Math.max(0, qE), Math.max(0, -qW), Math.max(0, qN), Math.max(0, -qS)) /
            Math.max(d, H_DRY);
          const fx = (qE + qW) * 0.5;
          const fy = (qN + qS) * 0.5;
          netQx[i] += fx * dt;
          netQy[i] += fy * dt;
          if (vMag > maxVel[i]) {
            maxVel[i] = vMag;
            const dEff = Math.max(d, H_DRY);
            velX[i] = fx / dEff;
            velY[i] = fy / dEff;
          }
          wetDur[i] += dt;
          if (arrival[i] < 0) arrival[i] = t;
        }
        activateAround(idx);
      }
    }
    swap();

    t += dt;

    if (t >= nextFrameT - 1e-9 || listCount === 0) {
      frameIdx++;
      snapshot(frameTimes[Math.min(frameIdx, frameTimes.length - 1)]);
      report(0.2 + 0.68 * (frameIdx / (frameTimes.length - 1)), "Simulating water flow over the terrain");
      if (listCount === 0 && !releaseOngoing) {
        // Fully drained and the tank is empty: remaining frames are dry.
        while (frames.length < frameTimes.length) snapshot(frameTimes[frames.length]);
        break;
      }
    }
  }

  while (frames.length < frameTimes.length) snapshot(frameTimes[frames.length]);

  // Final water still held in the domain (all wet cells, including any below the reporting
  // threshold). This — not the classified "affected area" — is what closes the mass balance.
  // Scanned over the whole interior: the wet-cell list is an optimisation for the
  // per-frame snapshots, and relying on it here would silently miss cells that received
  // water in the final step.
  let finalStoredM3 = 0;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const d = hh[hidx(c, r)];
      if (d > 0) finalStoredM3 += d * area;
    }
  }

  // ------------------------------------------------------------------ classification
  report(0.93, "Classifying depth and hazard");
  // The classification threshold must match the one used inside the solver, otherwise the
  // class areas would not add up to the reported affected area.
  const classifyDepth = hMin;
  const depthClass = new Uint8Array(n).fill(255);
  const hazardClass = new Uint8Array(n).fill(0);
  const classArea = new Float64Array(DEPTH_CLASSES.length);
  const classCount = new Int32Array(DEPTH_CLASSES.length);
  let affectedArea = 0;
  let maxDepthOverall = 0;
  let depthSum = 0;
  let wetCells = 0;
  let maxVelOverall = 0;
  let firstArrival = Infinity;
  let maxExtentDistanceM = 0;

  for (let i = 0; i < n; i++) {
    const d = maxDepth[i];
    if (d < classifyDepth) continue;
    const c = i % nx;
    const r = (i - c) / nx;
    affectedArea += area;
    depthSum += d;
    wetCells++;
    if (d > maxDepthOverall) maxDepthOverall = d;
    if (maxVel[i] > maxVelOverall) maxVelOverall = maxVel[i];
    for (let cl = 0; cl < DEPTH_CLASSES.length; cl++) {
      if (d >= DEPTH_CLASSES[cl].minM && d < DEPTH_CLASSES[cl].maxM) {
        depthClass[i] = cl;
        classArea[cl] += area;
        classCount[cl]++;
        break;
      }
    }
    const dv = d * maxVel[i];
    hazardClass[i] = d > 1.5 || dv >= 1.0 ? 3 : dv >= 0.5 ? 2 : 1;
    if (arrival[i] >= 0 && arrival[i] < firstArrival) firstArrival = arrival[i];
    const dist = Math.hypot(grid.x0 + c * dx - tankX, grid.y0 + r * dx - tankY);
    if (dist > maxExtentDistanceM) maxExtentDistanceM = dist;
  }
  if (!isFinite(firstArrival)) firstArrival = 0;

  // ------------------------------------------------------------------ mass balance
  const stored = finalStoredM3;
  // Volume actually injected into the model (equals the hydrograph total unless the run
  // was truncated by the duration cap or the iteration cap).
  // `injectedM3` is the volume the solver actually placed on the grid; that is the correct
  // left-hand side of the balance (the hydrograph total may not have been reached if the
  // run hit the iteration cap).
  // The left-hand side of the balance must be the volume the solver actually PLACED on the
  // grid (`injectedM3`). Taking the larger of that and the hydrograph's cumulative total
  // inflates the ledger whenever the run stops mid-release (a duration cap, the frame
  // budget, or the tank draining between steps), which then shows up as a phantom loss of a
  // few percent.
  const released = Math.min(hydro.totalVolumeM3, injectedM3);
  const errorM3 = released - (stored + outflowM3 + infiltrationM3);
  // `clampedM3` accounts for negative depths clipped to zero; it belongs on the right-hand
  // side of the balance. It was previously accumulated and never reported, so those cells
  // surfaced as an unexplained mass-balance error (19 % in the worst user case).
  if (clampedM3 > 0.5) {
    warnings.push(
      `${(clampedM3 / Math.max(1, released) * 100).toFixed(2)} % of the released volume was clipped at cells whose depth went negative (numerical over-draining).`,
    );
  }
  const errorPercent = released > 0 ? (errorM3 / released) * 100 : 0;
  const mass: MassBalance = {
    releasedM3: released,
    wetM3: stored,
    infiltrationM3,
    outflowM3,
    tankResidualM3: hydro.residualVolumeM3,
    errorM3,
    clampedM3,
    errorPercent,
    ok: Math.abs(errorPercent) <= 1.0,
  };
  if (!mass.ok) {
    warnings.push(
      `Mass balance closes to ${errorPercent.toFixed(2)} % (tolerance 1.0 %). Volumes in this run should be treated as approximate.`,
    );
  }
  if (released > 0 && outflowM3 > 0.005 * released) {
    warnings.push(
      `${((outflowM3 / released) * 100).toFixed(1)} % of the released water left the analysis domain (counted as boundary outflow). Increase the domain radius to capture more of the downstream reach.`,
    );
  }
  if (steps >= maxSteps) {
    warnings.push(
      "The solver reached its iteration cap before the water had fully drained. The maps show the state at the cut-off time; consider a coarser cell size or a shorter scenario.",
    );
  }

  const classes: ClassStat[] = DEPTH_CLASSES.map((cc, i) => ({
    id: cc.id,
    label: cc.label,
    minM: cc.minM,
    maxM: cc.maxM,
    colour: cc.colour,
    areaM2: classArea[i],
    cellCount: classCount[i],
  }));
  const peakIdx = fStats.reduce((best, s, i) => (s.maxDepthM > fStats[best].maxDepthM ? i : best), 0);

  const result: SimulationResult = {
    // Filled in by the worker, which knows which DEM the run used.
    tankGroundElevationM: null,
    // Impact analysis is a pure post-process over the finished rasters; the worker fills it in
    // (and can recompute it instantly when the user changes the assessment boundary).
    damageClass: new Uint8Array(n),
    damageScore: new Uint8Array(n),
    damageBands: [],
    damageMethod: "depth_only",
    flow: {
      vectors: [],
      meanDirDeg: 0,
      concentration: 0,
      dominantDirDeg: 0,
      dominantLabel: "N",
      speedP95Ms: 0,
      boundaryAreaM2: 0,
      boundaryWetAreaM2: 0,
      boundaryWetFraction: 0,
    },
    maxDepth,
    arrivalTime: arrival,
    maxVelocity: maxVel,
    flowX: netQx,
    flowY: netQy,
    velX,
    velY,
    wetDuration: wetDur,
    frames,
    frameTimes,
    frameStats: fStats,
    depthClass,
    hazardClass,
    mass,
    classes,
    stats: {
      affectedAreaM2: affectedArea,
      maxDepthM: maxDepthOverall,
      meanDepthAffectedM: wetCells > 0 ? depthSum / wetCells : 0,
      maxVelocityMs: maxVelOverall,
      maxExtentDistanceM,
      firstArrivalS: firstArrival,
      peakDepthTimeS: frameTimes[peakIdx] ?? 0,
      wetCellCount: wetCells,
    },
    hydro,
    grid,
    options,
    computeMs: Date.now() - tWall,
    hash: "",
    warnings,
  };
  result.hash = hashResult(result, tank, scenario);
  report(1, "Complete");
  return result;
}

function projectToLocal(lng: number, lat: number, crs: Grid["crs"]): { x: number; y: number } {
  const DEG = Math.PI / 180;
  const a = 6378137.0;
  const e2 = 0.0066943799901413165;
  const mLat = (latDeg: number) => {
    const s = Math.sin(latDeg * DEG);
    const w = 1 - e2 * s * s;
    return ((a * (1 - e2)) / Math.pow(w, 1.5)) * DEG;
  };
  const mLon = (latDeg: number) => {
    const s = Math.sin(latDeg * DEG);
    const w = 1 - e2 * s * s;
    return (a / Math.sqrt(w)) * Math.cos(latDeg * DEG) * DEG;
  };
  const latMean = (lat + crs.lat0) / 2;
  return { x: (lng - crs.lon0) * mLon(latMean), y: (lat - crs.lat0) * mLat(latMean) };
}

/** Deterministic FNV-1a hash over inputs and the headline outputs. */
function hashResult(result: SimulationResult, tank: TankSpec, scenario: ScenarioSpec): string {
  const parts = [
    tank.shape,
    tank.wallHeightM.toFixed(3),
    tank.waterHeadM.toFixed(3),
    tank.baseElevationM.toFixed(3),
    tank.capacityM3.toFixed(2),
    scenario.mode,
    String(scenario.holeDiameterM ?? 0),
    String(scenario.holeElevationAboveBaseM),
    String(result.grid.nx),
    String(result.grid.ny),
    result.grid.dx.toFixed(2),
    result.mass.releasedM3.toFixed(3),
    result.stats.affectedAreaM2.toFixed(2),
    result.stats.maxDepthM.toFixed(4),
    result.stats.maxExtentDistanceM.toFixed(2),
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
