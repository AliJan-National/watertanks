/**
 * Analysis grid construction from a DEM window.
 *
 * The DEM arrives as a rectangular lon/lat window sampled by whatever provider was
 * used. Everything downstream (routing, exposure, exports) uses a square, metric grid
 * in the local azimuthal-equidistant projection anchored at the tank, because:
 *   - distances, areas and velocities must be in metres, not degrees;
 *   - a square metric grid keeps the heap/flood algorithms simple and fast;
 *   * the per-cell area is constant, which makes volume bookkeeping exact.
 */

import { makeLocalCRS, metresPerDegLat, metresPerDegLon, project, unproject } from "./geo";
import type { DemMetadata, Grid, GridExtent, LocalCRS } from "./types";

export interface DemWindow {
  /** Source raster, row-major, row 0 = NORTH (matches GeoTIFF / tile order). */
  data: Float32Array;
  nx: number;
  ny: number;
  /** South-west corner of the *outer* corner of pixel (0,0) meaning min lon / min lat. */
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  metadata: DemMetadata;
  /** Optional per-cell mask of source nodata (1 = nodata/interpolated). */
  nodataMask?: Uint8Array;
}

export interface BuildGridOptions {
  centreLon: number;
  centreLat: number;
  /** Desired analysis cell size, metres. */
  targetCellSizeM: number;
  /** Domain radius around the tank, metres. */
  radiusM: number;
  /** Hard cap on cell count; the cell size is coarsened to respect it. */
  maxCells: number;
  smooth: boolean;
}

export interface GridBuildResult {
  grid: Grid;
  extent: GridExtent;
  /** True if the requested cell size had to be coarsened to respect maxCells. */
  coarsened: boolean;
  requestedCellSizeM: number;
  /** Number of cells interpolated because the DEM had gaps. */
  interpolatedCells: number;
  warnings: string[];
}

export function buildGrid(dem: DemWindow, opts: BuildGridOptions): GridBuildResult {
  const warnings: string[] = [];
  const crs = makeLocalCRS(opts.centreLon, opts.centreLat);

  // --- pick a cell size that fits the budget -----------------------------------
  let dx = Math.max(1, opts.targetCellSizeM);
  const diameter = 2 * opts.radiusM;
  let coarsened = false;
  for (let guard = 0; guard < 40; guard++) {
    const n = Math.ceil(diameter / dx);
    if (n * n <= opts.maxCells) break;
    dx *= 1.15;
    coarsened = true;
  }
  const nx = Math.max(8, Math.ceil(diameter / dx));
  const ny = nx;

  // Grid origin: centre the domain on the tank.
  const x0 = -((nx - 1) / 2) * dx;
  const y0 = -((ny - 1) / 2) * dx;

  // --- sample the DEM onto the metric grid (bilinear in lon/lat) ---------------
  const z = new Float32Array(nx * ny);
  let interpolated = 0;
  const lonPerCell = metresPerDegLon(opts.centreLat);
  const latPerCell = metresPerDegLat(opts.centreLat);
  void crs.unitScale;

  const sampleDem = (lon: number, lat: number): number => {
    const fx = ((lon - dem.minLon) / (dem.maxLon - dem.minLon)) * dem.nx - 0.5;
    const fy = ((dem.maxLat - lat) / (dem.maxLat - dem.minLat)) * dem.ny - 0.5; // row 0 = north
    const j0 = Math.floor(fx);
    const i0 = Math.floor(fy);
    const tx = fx - j0;
    const ty = fy - i0;
    const at = (i: number, jj: number): number => {
      const ci = Math.max(0, Math.min(dem.ny - 1, i));
      const cj = Math.max(0, Math.min(dem.nx - 1, jj));
      const v = dem.data[ci * dem.nx + cj];
      return Number.isFinite(v) ? v : NaN;
    };
    const v00 = at(i0, j0);
    const v01 = at(i0, j0 + 1);
    const v10 = at(i0 + 1, j0);
    const v11 = at(i0 + 1, j0 + 1);
    const vals = [v00, v01, v10, v11].filter((v) => Number.isFinite(v)) as number[];
    if (vals.length === 0) return NaN;
    if (vals.length < 4) {
      interpolated++;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    // bilinear
    const a = v00 * (1 - tx) + v01 * tx;
    const b = v10 * (1 - tx) + v11 * tx;
    return a * (1 - ty) + b * ty;
  };

  for (let r = 0; r < ny; r++) {
    const y = y0 + r * dx;
    for (let c = 0; c < nx; c++) {
      const x = x0 + c * dx;
      const ll = unprojectWithCrs(x, y, crs, lonPerCell, latPerCell);
      const v = sampleDem(ll.lng, ll.lat);
      z[r * nx + c] = Number.isFinite(v) ? v : 0;
    }
  }

  // Fill remaining gaps (outside the DEM coverage) with the nearest valid value using a
  // simple two-pass "grow the edges" fill, then warn.
  const gapCount = fillGaps(z, nx, ny);
  if (gapCount > 0) {
    warnings.push(
      `${gapCount} cells (${((gapCount / (nx * ny)) * 100).toFixed(1)} %) fell outside the DEM window and were filled by edge extension. Increase the domain radius or check the DEM source.`,
    );
  }
  if (interpolated > 0) {
    warnings.push(`${interpolated} cells were interpolated across DEM voids.`);
  }

  if (opts.smooth) smooth3x3(z, nx, ny);

  // Statistics for the metadata badge.
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < z.length; i++) {
    if (z[i] < minZ) minZ = z[i];
    if (z[i] > maxZ) maxZ = z[i];
  }

  const grid: Grid = { nx, ny, x0, y0, dx, z, crs };
  const extent: GridExtent = {
    minX: x0 - dx / 2,
    minY: y0 - dx / 2,
    maxX: x0 + (nx - 0.5) * dx,
    maxY: y0 + (ny - 0.5) * dx,
  };

  return {
    grid,
    extent,
    coarsened,
    requestedCellSizeM: opts.targetCellSizeM,
    interpolatedCells: gapCount,
    warnings,
  };
}

function unprojectWithCrs(x: number, y: number, crs: LocalCRS, lonPerCell: number, latPerCell: number) {
  const lat = crs.lat0 + y / latPerCell;
  return { lng: crs.lon0 + x / lonPerCell, lat };
}

/** Extends valid values outward to fill NaN cells; returns the number filled. */
function fillGaps(z: Float32Array, nx: number, ny: number): number {
  let nan = 0;
  for (let i = 0; i < z.length; i++) if (!Number.isFinite(z[i])) nan++;
  if (nan === 0) return 0;
  const filled = new Uint8Array(z.length);
  // North-south pass
  for (let c = 0; c < nx; c++) {
    let last = NaN;
    for (let r = 0; r < ny; r++) {
      const i = r * nx + c;
      if (Number.isFinite(z[i])) last = z[i];
      else if (Number.isFinite(last)) {
        z[i] = last;
        filled[i] = 1;
      }
    }
    last = NaN;
    for (let r = ny - 1; r >= 0; r--) {
      const i = r * nx + c;
      if (Number.isFinite(z[i])) last = z[i];
      else if (Number.isFinite(last)) {
        z[i] = last;
        filled[i] = 1;
      }
    }
  }
  // East-west pass
  for (let r = 0; r < ny; r++) {
    let last = NaN;
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (Number.isFinite(z[i])) last = z[i];
      else if (Number.isFinite(last)) {
        z[i] = last;
        filled[i] = 1;
      }
    }
    last = NaN;
    for (let c = nx - 1; c >= 0; c--) {
      const i = r * nx + c;
      if (Number.isFinite(z[i])) last = z[i];
      else if (Number.isFinite(last)) {
        z[i] = last;
        filled[i] = 1;
      }
    }
  }
  let remaining = 0;
  for (let i = 0; i < z.length; i++) {
    if (!Number.isFinite(z[i])) {
      z[i] = 0;
      remaining++;
    }
  }
  return Math.max(nan, remaining);
}

/** Light 3×3 mean filter that removes single-cell spikes without destroying relief. */
export function smooth3x3(z: Float32Array, nx: number, ny: number) {
  const out = new Float32Array(z.length);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      let s = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
          const w = dr === 0 && dc === 0 ? 2 : 1;
          s += z[rr * nx + cc] * w;
          n += w;
        }
      }
      out[r * nx + c] = s / n;
    }
  }
  z.set(out);
}

/** Hillshade (0-255) for terrain visualisation. */
export function hillshade(grid: Grid, azimuthDeg = 315, altitudeDeg = 45, zFactor = 1): Uint8ClampedArray {
  const { nx, ny, dx, z } = grid;
  const out = new Uint8ClampedArray(nx * ny * 4);
  const az = (azimuthDeg * Math.PI) / 180;
  const alt = (altitudeDeg * Math.PI) / 180;
  const cosAlt = Math.cos(alt);
  const sinAlt = Math.sin(alt);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      const e = z[r * nx + Math.min(nx - 1, c + 1)];
      const w = z[r * nx + Math.max(0, c - 1)];
      const n = z[Math.min(ny - 1, r + 1) * nx + c];
      const s = z[Math.max(0, r - 1) * nx + c];
      const dzdx = ((e - w) * zFactor) / (2 * dx);
      const dzdy = ((n - s) * zFactor) / (2 * dx);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, dzdy);
      let shade = cosAlt * Math.cos(slope) + sinAlt * Math.sin(slope) * Math.cos(az - aspect);
      shade = Math.max(0, Math.min(1, shade));
      const v = Math.round(40 + 200 * shade);
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** Slope in degrees. */
export function slopeDeg(grid: Grid): Float32Array {
  const { nx, ny, dx, z } = grid;
  const out = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      const e = z[r * nx + Math.min(nx - 1, c + 1)];
      const w = z[r * nx + Math.max(0, c - 1)];
      const n = z[Math.min(ny - 1, r + 1) * nx + c];
      const s = z[Math.max(0, r - 1) * nx + c];
      const dzdx = (e - w) / (2 * dx);
      const dzdy = (n - s) / (2 * dx);
      out[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return out;
}

/** D8 flow direction + accumulation, used only for the indicative flow-path line. */
export function flowAccumulation(grid: Grid, seedIdx: number[]): { accum: Float32Array; upstreamOf: Int32Array } {
  const { nx, ny, dx, z } = grid;
  const n = nx * ny;
  const dir = new Int32Array(n).fill(-1);
  const nb = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  // Steepest descent, with a tiny carrier to break flats deterministically.
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      let bestSlope = 0;
      let best = -1;
      for (let k = 0; k < 8; k++) {
        const cc = c + nb[k][0];
        const rr = r + nb[k][1];
        if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue;
        const j = rr * nx + cc;
        const dist = k < 4 ? dx : dx * Math.SQRT2;
        const slope = (z[i] - z[j]) / dist;
        if (slope > bestSlope + 1e-9) {
          bestSlope = slope;
          best = j;
        }
      }
      dir[i] = best;
    }
  }
  const accum = new Float32Array(n);
  for (const s of seedIdx) accum[s] = 1;
  // Process cells in descending elevation order so upstream contributions arrive first.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const zc = z;
  order.sort((a, b) => zc[b] - zc[a]);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const j = dir[i];
    if (j >= 0 && accum[i] > 0) accum[j] += accum[i];
  }
  return { accum, upstreamOf: dir };
}

/** Utility for exports: lon/lat of a cell centre. */
export function cellToLonLat(grid: Grid, col: number, row: number): { lng: number; lat: number } {
  return projectInverse(grid.x0 + col * grid.dx, grid.y0 + row * grid.dx, grid.crs);
}

/** Utility: local metres -> lon/lat, exported for the map layer and KMZ writer. */
export function projectInverse(x: number, y: number, crs: LocalCRS): { lng: number; lat: number } {
  return unproject(x, y, crs);
}

/** Utility: lon/lat -> local metres. */
export function projectForward(lng: number, lat: number, crs: LocalCRS): { x: number; y: number } {
  return project(lng, lat, crs);
}

/** Bounding box of the grid in lon/lat (for KMZ GroundOverlay / map image). */
export function gridLonLatBounds(grid: Grid): { west: number; south: number; east: number; north: number } {
  const sw = projectInverse(grid.x0 - grid.dx / 2, grid.y0 - grid.dx / 2, grid.crs);
  const ne = projectInverse(
    grid.x0 + (grid.nx - 0.5) * grid.dx,
    grid.y0 + (grid.ny - 0.5) * grid.dx,
    grid.crs,
  );
  return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
}
