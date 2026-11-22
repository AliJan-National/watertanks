/**
 * DEM acquisition.
 *
 * Default: Mapzen / AWS "Terrarium" elevation tiles (public, no key, 30 m, WGS84).
 * Why not raw Copernicus COGs as the default? A COG window read needs HTTP range support
 * from the host *and* a tile-cache friendly path; terrarium PNGs are the same underlying
 * data, work in any browser without CORS pain, and let us stream exactly the tiles we
 * need. Copernicus GLO-30 via the AWS open-data COGs is exposed as an explicit option.
 *
 * Every source returns the same shape: a rectangular lon/lat window, row 0 = NORTH,
 * plus metadata that is surfaced in the UI and in every export (resolution, vertical
 * accuracy, DSM-vs-DTM, licence, attribution).
 */

import type { DemMetadata, DemSourceId } from "../engine/types";
import type { DemWindow } from "../engine/grid";
import { lngLatToTile } from "../engine/geo";

export interface DemSource {
  id: DemSourceId;
  label: string;
  resolutionM: number;
  verticalAccuracyM: number | null;
  surfaceModel: boolean;
  attribution: string;
  licence: string;
  /** Fetch a lon/lat window. */
  fetch(opts: {
    west: number;
    south: number;
    east: number;
    north: number;
    signal?: AbortSignal;
    onProgress?: (p: { loaded: number; total: number; label: string }) => void;
  }): Promise<DemWindow>;
}

const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRARIUM_VRT_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif";

/**
 * Loads an image (any CORS-enabled URL) and returns its pixel data.
 *
 * This runs inside the simulation Web Worker, where `document` does not exist — so the
 * drawing surface has to be an OffscreenCanvas. Using a DOM canvas here silently failed
 * for every tile, which produced an all-nodata DEM and a flat, fabricated terrain.
 */
async function loadImagePixels(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url, { signal, mode: "cors" });
  if (!res.ok) throw new Error(`Tile fetch failed: ${res.status} ${url}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  } else if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!ctx) {
    bmp.close();
    throw new Error("No 2-D canvas implementation available to decode terrain tiles");
  }
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  bmp.close();
  return { data: img.data, width: w, height: h };
}

/**
 * Decodes Mapzen terrarium PNG. Height = (R * 256 + G + B / 256) - 32768.
 * Invalid / masked pixels come back as 0 (which decodes to -32768 and is treated as nodata).
 */
function decodeTerrarium(rgba: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a === 0 || (r === 0 && g === 0 && b === 0)) {
      out[i] = NaN;
    } else {
      out[i] = r * 256 + g + b / 256 - 32768;
    }
  }
  return out;
}

const TERRARIUM_SOURCE: DemSource = {
  id: "terrarium_z15",
  label: "AWS Terrain Tiles (Terrarium, 30 m)",
  resolutionM: 30,
  verticalAccuracyM: 4,
  surfaceModel: true,
  attribution: "Elevation: Mapzen/AWS Terrain Tiles (SRTM/NED/3DEP/ETOPO composite), public domain",
  licence: "Public domain / CC0 (AWS Open Data)",
  async fetch({ west, south, east, north, signal, onProgress }) {
    // Choose the zoom that gives roughly 30 m ground resolution at this latitude so the
    // download stays in the few-MB range for a 10 km domain.
    let z = pickZoom(west, south, east, north, 30);
    const t0 = lngLatToTile(west, north, z); // top-left
    const t1 = lngLatToTile(east, south, z); // bottom-right
    const x0 = Math.floor(t0.x);
    const x1 = Math.floor(t1.x);
    const y0 = Math.floor(t0.y);
    const y1 = Math.floor(t1.y);
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    const nTiles = cols * rows;
    if (nTiles > 400) {
      throw new Error(
        `This domain needs ${nTiles} DEM tiles. Reduce the radius or choose a coarser cell size.`,
      );
    }
    const tileSize = 256;
    const W = cols * tileSize;
    const H = rows * tileSize;
    const out = new Float32Array(W * H).fill(NaN);
    let done = 0;
    const queue: { x: number; y: number }[] = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) queue.push({ x: tx, y: ty });

    const concurrency = 6;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const { x, y } = queue[idx];
        const url = TERRARIUM_URL.replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
        try {
          const { data, width, height } = await loadImagePixels(url, signal);
          const px = decodeTerrarium(data, width * height);
          const ox = (x - x0) * tileSize;
          const oy = (y - y0) * tileSize;
          for (let r = 0; r < height; r++) {
            const rowStart = (oy + r) * W + ox;
            for (let c = 0; c < width; c++) out[rowStart + c] = px[r * width + c];
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          // leave NaN: the grid builder will count and report the gap
        }
        done++;
        onProgress?.({ loaded: done, total: nTiles, label: "Elevation tiles" });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Georeference the mosaic. Use the tile corners so the result is exact.
    const bounds = tileBounds(x0, y0, x1, y1, z);
    const nodata = countNodata(out);
    // AWS Terrain Tiles are only published up to z15 in most of the world. If the whole
    // mosaic came back empty, step down the zoom ladder and try again before giving up.
    if (nodata >= 0.999 && z > 10) {
      const coarser = z - 1;
      const c0 = lngLatToTile(west, north, coarser);
      const c1 = lngLatToTile(east, south, coarser);
      const cb = tileBounds(Math.floor(c0.x), Math.floor(c0.y), Math.floor(c1.x), Math.floor(c1.y), coarser);
      return TERRARIUM_SOURCE.fetch({ west: cb.west, south: cb.south, east: cb.east, north: cb.north, signal, onProgress });
    }
    return {
      data: out,
      nx: W,
      ny: H,
      minLon: bounds.west,
      maxLon: bounds.east,
      minLat: bounds.south,
      maxLat: bounds.north,
      metadata: {
        source: "terrarium_z15",
        label: TERRARIUM_SOURCE.label,
        resolutionM: 30,
        // Ground size of one DEM pixel at this latitude: the tiles are 256 px wide.
        nativeCellSizeM: Math.round(
          (((bounds.east - bounds.west) * 111320 * Math.cos((south * Math.PI) / 180)) / W) * 10,
        ) / 10,
        verticalAccuracyM: 4,
        surfaceModel: true,
        attribution: TERRARIUM_SOURCE.attribution,
        licence: TERRARIUM_SOURCE.licence,
        gridCellSizeM: 0,
        nodataFraction: nodata,
        minZM: 0,
        maxZM: 0,
      },
    } as DemWindow;
  },
};

/**
 * Copernicus GLO-30 as COG. Reads the native 1°x1° tiles through geotiff.js, which issues
 * HTTP range requests, so only the parts of the tile we need are downloaded.
 */
const COPERNICUS_SOURCE: DemSource = {
  id: "copernicus_glo30",
  label: "Copernicus DEM GLO-30 (30 m DSM)",
  resolutionM: 30,
  verticalAccuracyM: 2.5,
  surfaceModel: true,
  attribution: "© DLR e.V. / ESA / Airbus — Copernicus GLO-30 DSM, AWS Open Data",
  licence: "Copernicus DEM free licence (AWS Open Data registry)",
  async fetch({ west, south, east, north, signal, onProgress }) {
    const { fromUrl } = await import("geotiff");
    const pieces: { data: Float32Array; nx: number; ny: number; bounds: number[] }[] = [];
    const tilesLon = range(Math.floor(west), Math.floor(east));
    const tilesLat = range(Math.floor(south), Math.floor(north));
    const jobs: { lon: number; lat: number }[] = [];
    for (const lat of tilesLat) for (const lon of tilesLon) jobs.push({ lon, lat });
    if (jobs.length > 9) throw new Error("Copernicus window too large; reduce the domain radius.");

    let done = 0;
    for (const job of jobs) {
      const name = copernicusName(job.lat, job.lon, 10);
      const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
      try {
        onProgress?.({ loaded: done, total: jobs.length, label: "Copernicus DEM" });
        const tiff = await fromUrl(url);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        // Windowed read of the requested sub-area.
        const bbox = image.getBoundingBox();
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const colFrac0 = (west - minLon) / (maxLon - minLon);
        const colFrac1 = (east - minLon) / (maxLon - minLon);
        const rowFrac0 = (maxLat - north) / (maxLat - minLat);
        const rowFrac1 = (maxLat - south) / (maxLat - minLat);
        const w0 = Math.max(0, Math.floor(colFrac0 * width));
        const w1 = Math.min(width, Math.ceil(colFrac1 * width));
        const h0 = Math.max(0, Math.floor(rowFrac0 * height));
        const h1 = Math.min(height, Math.ceil(rowFrac1 * height));
        if (w1 <= w0 || h1 <= h0) continue;
        const rasters = await image.readRasters({ window: [w0, h0, w1, h1], signal });
        const band = rasters[0] as unknown as Float32Array | Int16Array;
        const nx = w1 - w0;
        const ny = h1 - h0;
        const data = new Float32Array(nx * ny);
        for (let i = 0; i < data.length; i++) {
          const v = (band as ArrayLike<number>)[i];
          data[i] = Number.isFinite(v) && v > -1000 ? v : NaN;
        }
        pieces.push({ data, nx, ny, bounds: [minLon, minLat, maxLon, maxLat] });
      } catch (e) {
        if (signal?.aborted) throw e;
        // The Copernicus public bucket does not send Access-Control-Allow-Origin, so a
        // browser cannot range-read it. Say so plainly instead of implying a network fault.
        throw new Error(
          `Copernicus DEM could not be read in the browser (${name}). The public S3 bucket ` +
            `does not send CORS headers, so COG range reads only work via the optional ` +
            `server-side mode. Use the AWS Terrain Tiles source (CORS-enabled) or upload a GeoTIFF.`,
        );
      }
      done++;
    }
    if (pieces.length === 0) throw new Error("No Copernicus DEM data returned for this window.");
    // Single-tile fast path (the common case).
    if (pieces.length === 1) {
      const p = pieces[0];
      return finishWindow(p.data, p.nx, p.ny, p.bounds, COPERNICUS_SOURCE);
    }
    return mosaic(pieces, COPERNICUS_SOURCE);
  },
};

/** Stub entries so the provider list is honest about what is and is not wired up. */
export const DEM_SOURCES: DemSource[] = [COPERNICUS_SOURCE, TERRARIUM_SOURCE];

export function getDemSource(id: DemSourceId): DemSource {
  const s = DEM_SOURCES.find((x) => x.id === id);
  if (!s) {
    throw new Error(
      `DEM source "${id}" is not available in this build. Available: ${DEM_SOURCES.map((d) => d.id).join(", ")}.`,
    );
  }
  return s;
}

// ---------------------------------------------------------------- helpers

/** Picks the web-mercator zoom whose resolution is closest to the target GSD at this latitude. */
export function pickZoom(west: number, south: number, east: number, north: number, gsdM: number): number {
  const lat = (south + north) / 2;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const spanM = (east - west) * mPerDegLon;
  // AWS Terrain Tiles stop at z15 in most of the world, so probing above that only
  // produces 404s and an all-nodata mosaic.
  for (let z = 15; z >= 8; z--) {
    const tiles = spanM / (156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, z));
    const tileSpanM = 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, z);
    const tilePixels = tileSpanM / 256;
    if (tilePixels <= gsdM * 1.6) return Math.min(z, 15);
    void tiles;
  }
  return 12;
}

export function tileBounds(x0: number, y0: number, x1: number, y1: number, z: number) {
  const n = Math.pow(2, z);
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => {
    const v = Math.PI - (2 * Math.PI * y) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(v) - Math.exp(-v)));
  };
  return { west: lon(x0), east: lon(x1 + 1), north: lat(y0), south: lat(y1 + 1) };
}

function countNodata(a: Float32Array): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) c++;
  return c / a.length;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to; v++) out.push(v);
  return out;
}

/** Copernicus tile naming: Copernicus_DSM_COG_10_N24_00_E039_00_DEM */
export function copernicusName(latFloor: number, lonFloor: number, resolution: 10 | 30): string {
  const ns = latFloor >= 0 ? "N" : "S";
  const ew = lonFloor >= 0 ? "E" : "W";
  const la = String(Math.abs(latFloor)).padStart(2, "0");
  const lo = String(Math.abs(lonFloor)).padStart(3, "0");
  return `Copernicus_DSM_COG_${resolution}_${ns}${la}_00_${ew}${lo}_00_DEM`;
}

function finishWindow(
  data: Float32Array,
  nx: number,
  ny: number,
  bounds: number[],
  src: DemSource,
): DemWindow {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const meta: DemMetadata = {
    source: src.id,
    label: src.label,
    resolutionM: src.resolutionM,
    verticalAccuracyM: src.verticalAccuracyM,
    surfaceModel: src.surfaceModel,
    attribution: src.attribution,
    licence: src.licence,
    gridCellSizeM: 0,
    nodataFraction: countNodata(data),
    minZM: isFinite(min) ? min : 0,
    maxZM: isFinite(max) ? max : 0,
  };
  return {
    data,
    nx,
    ny,
    minLon: bounds[0],
    minLat: bounds[1],
    maxLon: bounds[2],
    maxLat: bounds[3],
    metadata: meta,
  };
}

function mosaic(pieces: { data: Float32Array; nx: number; ny: number; bounds: number[] }[], src: DemSource) {
  const west = Math.min(...pieces.map((p) => p.bounds[0]));
  const south = Math.min(...pieces.map((p) => p.bounds[1]));
  const east = Math.max(...pieces.map((p) => p.bounds[2]));
  const north = Math.max(...pieces.map((p) => p.bounds[3]));
  // Resolution from the first piece.
  const p0 = pieces[0];
  const resLon = (p0.bounds[2] - p0.bounds[0]) / p0.nx;
  const resLat = (p0.bounds[3] - p0.bounds[1]) / p0.ny;
  const nx = Math.round((east - west) / resLon);
  const ny = Math.round((north - south) / resLat);
  const out = new Float32Array(nx * ny).fill(NaN);
  for (const p of pieces) {
    const ox = Math.round((p.bounds[0] - west) / resLon);
    const oy = Math.round((north - p.bounds[3]) / resLat);
    for (let r = 0; r < p.ny; r++) {
      const target = (oy + r) * nx + ox;
      for (let c = 0; c < p.nx; c++) {
        const v = p.data[r * p.nx + c];
        if (Number.isFinite(v)) out[target + c] = v;
      }
    }
  }
  return finishWindow(out, nx, ny, [west, south, east, north], src);
}

/** Parses a user-uploaded GeoTIFF DEM (drag & drop in the UI). */
export async function loadUserGeoTiff(file: File): Promise<DemWindow> {
  const { fromArrayBuffer } = await import("geotiff");
  const buf = await file.arrayBuffer();
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const band = rasters[0] as unknown as ArrayLike<number>;
  const nx = image.getWidth();
  const ny = image.getHeight();
  const data = new Float32Array(nx * ny);
  let nodata = image.getGDALNoData();
  for (let i = 0; i < data.length; i++) {
    const v = Number(band[i]);
    data[i] = Number.isFinite(v) && (nodata === null || v !== nodata) ? v : NaN;
  }
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  let res = 0;
  try {
    const rp = (image as any).getResolution?.();
    if (Array.isArray(rp)) res = Math.abs(rp[0]) * 111320 * Math.cos((minLat * Math.PI) / 180);
  } catch {
    res = 0;
  }
  const meta: DemMetadata = {
    source: "user_upload",
    label: `Uploaded DEM — ${file.name}`,
    resolutionM: Math.round(res || 0),
    verticalAccuracyM: null,
    surfaceModel: false,
    attribution: `User-supplied DEM: ${file.name}`,
    licence: "Supplied by the user — not redistributed by this application",
    gridCellSizeM: 0,
    nodataFraction: countNodata(data),
    minZM: 0,
    maxZM: 0,
  };
  return finishWindow(data, nx, ny, [minLon, minLat, maxLon, maxLat], {
    ...TERRARIUM_SOURCE,
    id: "user_upload",
    label: meta.label,
    resolutionM: meta.resolutionM,
    verticalAccuracyM: null,
    surfaceModel: false,
    attribution: meta.attribution,
    licence: meta.licence,
  });
}

export { TERRARIUM_VRT_URL };
