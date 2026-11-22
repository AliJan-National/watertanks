/// <reference lib="webworker" />
/**
 * Simulation worker.
 *
 * Runs the whole pipeline off the main thread:
 *   fetch DEM -> build metric grid -> release hydrograph -> 2-D shallow flow
 *   -> depth/hazard classes -> expose grids for rendering.
 *
 * Depth rasters are transferred back as raw ArrayBuffers (zero-copy) and turned into
 * canvases on the main thread only when a frame is actually displayed.
 */

import { buildGrid } from "../engine/grid";
import { computeHydrograph, tankGeometry } from "../engine/hydrograph";
import { simulateShallowFlow } from "../engine/shallowFlow";
import { DEM_SOURCES, getDemSource } from "../providers/dem";
import { analyseDamage, analyseFlow } from "../analysis/impact";
import { makeLocalCRS, metresPerDegLat, metresPerDegLon } from "../engine/geo";
import type { DemMetadata, DemSourceId, ScenarioSpec, SimulationOptions, TankSpec } from "../engine/types";

export interface SimulateRequest {
  type: "simulate";
  jobId: number;
  tank: TankSpec;
  scenario: ScenarioSpec;
  options: SimulationOptions;
  demSourceId: string;
  /** Optional pre-loaded DEM (user upload): transferred in, not fetched. */
  dem?: {
    data: ArrayBuffer;
    nx: number;
    ny: number;
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
    metadata: DemMetadata;
  };
}

export interface CancelRequest {
  type: "cancel";
  jobId: number;
}

/** Fast DEM lookup for a single point, used to pre-fill the tank base elevation. */
export interface ProbeRequest {
  type: "probe";
  jobId: number;
  lng: number;
  lat: number;
  demSourceId: string;
}

export type WorkerRequest = SimulateRequest | CancelRequest | ProbeRequest;

export interface ProgressMessage {
  type: "progress";
  jobId: number;
  fraction: number;
  stage: string;
}

export interface ResultMessage {
  type: "result";
  jobId: number;
  payload: {
    grid: {
      nx: number;
      ny: number;
      dx: number;
      x0: number;
      y0: number;
      z: ArrayBuffer;
      crs: { lon0: number; lat0: number; unitScale: number; proj4: string };
    };
    metadata: DemMetadata;
    tankGroundElevationM: number | null;
    damageClass: ArrayBuffer;
    damageScore: ArrayBuffer;
    damageBands: any[];
    damageMethod: "hazard_depth" | "depth_only";
    flow: any;
    hydro: any;
    frames: ArrayBuffer[];
    frameTimes: number[];
    frameStats: any[];
    maxDepth: ArrayBuffer;
    arrivalTime: ArrayBuffer;
    maxVelocity: ArrayBuffer;
    depthClass: ArrayBuffer;
    hazardClass: ArrayBuffer;
    mass: any;
    classes: any[];
    stats: any;
    options: SimulationOptions;
    computeMs: number;
    hash: string;
    warnings: string[];
  };
}

export interface ErrorMessage {
  type: "error";
  jobId: number;
  message: string;
}

let currentJob = -1;
let cancelled = -1;

const post = (msg: any, transfer?: Transferable[]) => {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelled = msg.jobId;
    return;
  }
  if (msg.type === "probe") {
    try {
      const source = getDemSource(msg.demSourceId as DemSourceId);
      // 900 m keeps the probe to a handful of tiles; terrain tiles are 30 m, so 30 cells is
      // more than enough to read the ground under the tank.
      const span = 900; // metres
      const bbox = bboxAround(msg.lng, msg.lat, span);
      let win;
      try {
        win = await source.fetch(bbox);
      } catch (e) {
        // A probe is a convenience, never a blocker: report it and move on.
        post({ type: "probeResult", jobId: msg.jobId, elevationM: null, error: (e as Error).message });
        return;
      }
      const fx = ((msg.lng - win.minLon) / (win.maxLon - win.minLon)) * win.nx - 0.5;
      const fy = ((win.maxLat - msg.lat) / (win.maxLat - win.minLat)) * win.ny - 0.5;
      const j = Math.max(0, Math.min(win.nx - 2, Math.round(fx)));
      const i = Math.max(0, Math.min(win.ny - 2, Math.round(fy)));
      let sum = 0;
      let n = 0;
      for (let di = 0; di <= 1; di++) {
        for (let dj = 0; dj <= 1; dj++) {
          const v = win.data[(i + di) * win.nx + (j + dj)];
          if (Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      post({ type: "probeResult", jobId: msg.jobId, elevationM: n ? sum / n : null, label: win.metadata.label });
    } catch (e) {
      post({ type: "probeResult", jobId: msg.jobId, elevationM: null, error: (e as Error).message });
    }
    return;
  }
  if (msg.type !== "simulate") return;
  const jobId = msg.jobId;
  currentJob = jobId;
  const progress = (fraction: number, stage: string) =>
    post({ type: "progress", jobId, fraction, stage } as ProgressMessage);

  try {
    const { tank, scenario, options } = msg;

    // ---------------------------------------------------------------- 1. DEM
    progress(0.02, "Locating terrain data");
    const radiusM = radiusForTank(tank, options);
    const bbox = bboxAround(tank.location.lng, tank.location.lat, radiusM * 1.25);
    let demWindow;
    let demFallbackNote: string | null = null;
    if (msg.dem) {
      demWindow = {
        data: new Float32Array(msg.dem.data),
        nx: msg.dem.nx,
        ny: msg.dem.ny,
        minLon: msg.dem.minLon,
        minLat: msg.dem.minLat,
        maxLon: msg.dem.maxLon,
        maxLat: msg.dem.maxLat,
        metadata: msg.dem.metadata,
      };
    } else {
      // Try the requested source first, then fall back to anything else registered (e.g.
      // Copernicus GLO-30 -> terrain tiles) rather than failing the whole run.
      const ids: DemSourceId[] = [msg.demSourceId as DemSourceId];
      for (const s of DEM_SOURCES) if (s.id !== msg.demSourceId) ids.push(s.id);
      let lastErr: unknown = null;
      const failures: string[] = [];
      for (const id of ids) {
        try {
          const source = getDemSource(id);
          progress(0.03, `Downloading ${source.label}`);
          const win = await source.fetch({
            ...bbox,
            onProgress: (p) => {
              if (p.total > 0) progress(0.03 + 0.17 * (p.loaded / p.total), `Downloading ${p.label}`);
            },
          });
          // An all-nodata window is a failed fetch, not terrain.
          if (win.metadata.nodataFraction >= 0.999) {
            failures.push(`${source.label}: every pixel came back as nodata`);
            continue;
          }
          demWindow = win;
          if (id !== msg.demSourceId) {
            demFallbackNote = `Requested DEM unavailable, used ${source.label} instead.`;
          }
          break;
        } catch (e) {
          lastErr = e;
          failures.push(`${id}: ${(e as Error).message}`);
        }
      }
      if (!demWindow) {
        throw new Error(
          `Could not load a digital elevation model. ${failures.join("; ")}` +
            (lastErr ? "" : "") +
            " Try the other DEM source, upload a GeoTIFF, or check your connection.",
        );
      }
    }
    if (cancelled === jobId) throw new Error("cancelled");
    if (demWindow.metadata.nodataFraction >= 0.999) {
      throw new Error(
        "The elevation model returned no valid data for this area. Try another DEM source or upload a GeoTIFF.",
      );
    }

    // ---------------------------------------------------------------- 2. grid
    progress(0.22, "Building analysis grid");
    const built = buildGrid(demWindow, {
      centreLon: tank.location.lng,
      centreLat: tank.location.lat,
      targetCellSizeM: options.cellSizeM ?? 12,
      radiusM,
      maxCells: options.maxCells,
      smooth: options.smoothDem,
    });
    const grid = built.grid;

    // Reconcile the tank base elevation with the DEM at the tank location, but never
    // silently overwrite the user's value: the difference is reported instead.
    const meta: DemMetadata = {
      ...demWindow.metadata,
      gridCellSizeM: grid.dx,
      nodataFraction: demWindow.metadata.nodataFraction,
      minZM: Math.min(...sampleEvery(grid.z, 97)),
      maxZM: Math.max(...sampleEvery(grid.z, 97)),
    };

    // ---------------------------------------------------------------- 3. hydrograph
    progress(0.3, "Computing the release hydrograph");
    const geom = tankGeometry(tank);
    const hydro = computeHydrograph(tank, scenario, geom);
    const warnings: string[] = [...built.warnings];
    if (demFallbackNote) warnings.push(demFallbackNote);
    if (hydro.totalVolumeM3 < 1) {
      warnings.push(
        "The modelled release is less than 1 m³. For overtopping scenarios this is expected when the water level is below the wall crest.",
      );
    }

    // ---------------------------------------------------------------- 4. flow
    const result = simulateShallowFlow({
      grid,
      tank,
      scenario,
      hydro,
      options,
      onProgress: (f, stage) => {
        if (cancelled === jobId) throw new Error("cancelled");
        progress(0.3 + 0.62 * f, stage);
      },
    });
    if (cancelled === jobId) throw new Error("cancelled");

    // Impact assessment inside the user's boundary (bands + flow-direction field).
    progress(0.94, "Assessing damage bands and flow directions");
    const areaKm2 = options.impactAreaKm2 ?? defaultAssessmentAreaKm2(grid);
    const damage = analyseDamage(result, areaKm2);
    result.damageClass = damage.damageClass;
    result.damageScore = damage.damageScore;
    result.damageBands = damage.bands;
    result.damageMethod = damage.method;
    const flow = analyseFlow(result, areaKm2);
    result.flow = flow;

    // Ground elevation under the tank, from the same DEM the run used. The UI offers this
    // as "use DEM value" so the user never has to guess the base elevation.
    {
      const gx = Math.round((0 - grid.x0) / grid.dx);
      const gy = Math.round((0 - grid.y0) / grid.dx);
      if (gx >= 0 && gy >= 0 && gx < grid.nx && gy < grid.ny) {
        result.tankGroundElevationM = grid.z[gy * grid.nx + gx];
      }
    }

    warnings.push(...result.warnings);

    // ---------------------------------------------------------------- 5. ship
    progress(0.97, "Preparing layers");
    const frameBuffers = result.frames.map((f) => f.buffer as ArrayBuffer);
    const transfer: Transferable[] = [
      grid.z.buffer as ArrayBuffer,
      result.maxDepth.buffer as ArrayBuffer,
      result.arrivalTime.buffer as ArrayBuffer,
      result.maxVelocity.buffer as ArrayBuffer,
      result.depthClass.buffer as ArrayBuffer,
      result.hazardClass.buffer as ArrayBuffer,
      result.damageClass.buffer as ArrayBuffer,
      result.damageScore.buffer as ArrayBuffer,
      ...frameBuffers,
    ];
    const payload: ResultMessage["payload"] = {
      grid: {
        nx: grid.nx,
        ny: grid.ny,
        dx: grid.dx,
        x0: grid.x0,
        y0: grid.y0,
        z: grid.z.buffer as ArrayBuffer,
        crs: grid.crs,
      },
      metadata: meta,
      hydro,
      frames: frameBuffers,
      frameTimes: result.frameTimes,
      frameStats: result.frameStats,
      maxDepth: result.maxDepth.buffer as ArrayBuffer,
      arrivalTime: result.arrivalTime.buffer as ArrayBuffer,
      maxVelocity: result.maxVelocity.buffer as ArrayBuffer,
      depthClass: result.depthClass.buffer as ArrayBuffer,
      hazardClass: result.hazardClass.buffer as ArrayBuffer,
      mass: result.mass,
      classes: result.classes,
      stats: result.stats,
      options,
      computeMs: result.computeMs,
      hash: result.hash,
      warnings,
      tankGroundElevationM: result.tankGroundElevationM,
      damageClass: result.damageClass.buffer as ArrayBuffer,
      damageScore: result.damageScore.buffer as ArrayBuffer,
      damageBands: result.damageBands,
      damageMethod: result.damageMethod,
      flow: result.flow,
    };
    post({ type: "result", jobId, payload } as ResultMessage, transfer);
  } catch (e: any) {
    const message = e?.message === "cancelled" ? "Simulation cancelled" : (e?.message ?? String(e));
    post({ type: "error", jobId, message } as ErrorMessage);
  } finally {
    if (currentJob === jobId) currentJob = -1;
  }
};

function sampleEvery(arr: Float32Array, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i += step) if (Number.isFinite(arr[i])) out.push(arr[i]);
  return out.length ? out : [0];
}

/** Domain radius in metres, scaled from the stored volume but bounded for usability. */
/**
 * Default assessment boundary: a square that just covers the analysis domain, so an un-set
 * boundary never hides modelled water. The user can tighten it to e.g. 1 km² in the UI.
 */
export function defaultAssessmentAreaKm2(grid: { nx: number; dx: number }): number {
  const side = grid.nx * grid.dx;
  return Math.max(0.01, Math.round(((side * side) / 1e6) * 1000) / 1000);
}

export function radiusForTank(tank: TankSpec, options: SimulationOptions): number {
  // A released volume spread thinly over sloping ground runs a long way. A domain that is
  // too small forces the water to pond against an artificial wall, which reads as a deep
  // flood. Scale the radius with the cube-ish root of the release and let the user override
  // it with `domainRadiusM`.
  const geom = tankGeometry(tank);
  const v = Math.max(50, geom.geometricCapacityM3);
  if (options.domainRadiusM && options.domainRadiusM > 0) {
    return Math.max(300, Math.min(20000, options.domainRadiusM));
  }
  const auto = 25 * Math.sqrt(v);
  return Math.max(600, Math.min(6000, auto));
}

export function bboxAround(lon: number, lat: number, radiusM: number) {
  const dLat = radiusM / metresPerDegLat(lat);
  const dLon = radiusM / metresPerDegLon(lat);
  return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
}

export { makeLocalCRS };
