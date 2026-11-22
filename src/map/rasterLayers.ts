/**
 * Raster overlays for MapLibre.
 *
 * The simulation produces Float32 grids. Rather than pushing hundreds of thousands of
 * polygons into the map (slow, and it loses the continuous colour ramp), each grid is
 * painted into an OffscreenCanvas and added as a georeferenced `image` source with four
 * corner coordinates. Re-painting is done only when a layer or frame changes.
 *
 * The image is drawn so that its top row is north (map tile order) and it is anchored on
 * the four grid corners computed in the local projection — never on a naive lat/lon box,
 * which would mis-register the overlay badly at these scales.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { Grid, SimulationResult } from "../engine/types";
import { DEPTH_CLASSES, HAZARD_CLASSES } from "../engine/shallowFlow";

export type RasterLayerId =
  | "raster-maxDepth"
  | "raster-depthNow"
  | "raster-arrival"
  | "raster-velocity"
  | "raster-hazard"
  | "raster-damage"
  | "raster-hillshade";

/** Colour ramp for depth (0 m -> 6 m), continuously interpolated with a soft fluid boundary fade. */
export function depthColour(d: number): [number, number, number, number] {
  if (d <= 0.001) return [0, 0, 0, 0];
  const stops: [number, number, number, number, number][] = [
    [0.001, 235, 248, 255, 0],   // Zero depth: transparent
    [0.01, 215, 240, 255, 65],   // Thin water film: soft tint
    [0.05, 185, 228, 255, 130],  // Ankle depth: pale blue
    [0.15, 134, 203, 255, 175],  // Curb height: sky blue
    [0.3, 79, 169, 240, 205],    // Wheel depth: azure
    [0.6, 43, 127, 224, 225],    // Knee depth: rich blue
    [1.2, 29, 84, 184, 235],     // Waist depth: royal blue
    [2.5, 20, 50, 160, 245],     // Submerged: deep navy
    [5.0, 107, 47, 160, 250],    // Reservoir: deep violet
  ];
  const v = Math.min(6, Math.max(0.001, d));
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (v <= b[0]) {
      const f = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
        Math.round(a[3] + (b[3] - a[3]) * f),
        Math.round(a[4] + (b[4] - a[4]) * f),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3], last[4]];
}

/**
 * Continuous heat-map ramp for the damage score (0–100).
 *
 * Interpolated continuously with an organic aquatic fade at the edge (alpha starts at 0),
 * transitioning through bright yellow into amber orange, coral, and deep crimson.
 */
export function damageColour(score: number): [number, number, number, number] {
  if (!(score > 0.05)) return [0, 0, 0, 0];
  const stops: [number, number, number, number, number][] = [
    [0.05, 56, 189, 248, 55],    // Outer perimeter / shallow flood: soft translucent water cyan
    [4, 56, 189, 248, 115],      // Shallow sheet flow: fluent sky blue
    [10, 125, 211, 252, 140],    // Light aqua transition
    [16, 254, 240, 138, 160],    // Pale yellow
    [24, 250, 204, 21, 185],     // Low hazard: bright yellow
    [42, 251, 146, 60, 210],     // Yellow-orange
    [58, 249, 115, 22, 225],     // Medium hazard: amber orange
    [76, 239, 68, 68, 238],      // High hazard: vivid red
    [100, 185, 28, 28, 250],     // Severe: deep crimson
  ];
  const v = Math.min(100, Math.max(0.05, score));
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (v <= b[0]) {
      const f = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
        Math.round(a[3] + (b[3] - a[3]) * f),
        Math.round(a[4] + (b[4] - a[4]) * f),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3], last[4]];
}

export function hazardColour(h: number): [number, number, number, number] {
  if (h <= 0) return [0, 0, 0, 0];
  if (h === 1) return [255, 213, 79, 190];
  if (h === 2) return [251, 140, 0, 210];
  return [229, 57, 53, 225];
}

function arrivalColour(seconds: number, maxSeconds: number): [number, number, number, number] {
  if (seconds < 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, Math.log10(1 + seconds) / Math.log10(1 + Math.max(60, maxSeconds))));
  // viridis-ish 5-stop ramp: purple -> blue -> green -> yellow
  const stops: [number, number, number][] = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const p = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    205,
  ];
}

function velocityColour(v: number, maxV: number): [number, number, number, number] {
  if (v <= 0.001) return [0, 0, 0, 0];
  const t = Math.min(1, v / Math.max(0.2, maxV));
  // yellow -> orange -> red
  const r = Math.round(255 * Math.min(1, 0.55 + 0.45 * t));
  const g = Math.round(255 * (1 - 0.72 * t));
  const b = Math.round(255 * (1 - 0.95 * t));
  return [r, g, b, 150 + Math.round(80 * t)];
}

export interface RasterPaintOptions {
  /** Frame index for the "depth at time" layer. */
  frameIndex: number;
  /** Max value used to normalise the arrival/velocity ramps. */
  arrivalMaxS: number;
  velocityMax: number;
  /** Optional pre-smoothed damage score field (0–100) for the heat-map layer. */
  damageField?: Float32Array;
}

/** Renders one grid to an ImageData-sized canvas and returns a data URL. */
export function paintRaster(
  kind: Exclude<RasterLayerId, "raster-hillshade">,
  result: SimulationResult,
  opts: RasterPaintOptions,
): string {
  const { grid } = result;
  const { nx, ny } = grid;
  // Sub-pixel grid scaling for silky smooth, organic fluid water contours
  const scale = Math.max(2, Math.min(4, Math.round(640 / Math.max(nx, ny))));
  const outW = nx * scale;
  const outH = ny * scale;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(outW, outH);
  const px = img.data;

  let source: ArrayLike<number>;
  switch (kind) {
    case "raster-maxDepth":
      source = result.maxDepth;
      break;
    case "raster-depthNow":
      source = result.frames[Math.min(opts.frameIndex, result.frames.length - 1)];
      break;
    case "raster-arrival":
      source = result.arrivalTime;
      break;
    case "raster-velocity":
      source = result.maxVelocity;
      break;
    case "raster-damage":
      source = opts.damageField ?? result.damageScore;
      break;
    default:
      source = result.hazardClass;
  }

  for (let r = 0; r < outH; r++) {
    // Grid row 0 is the SOUTH edge; image row 0 must be the NORTH edge.
    const srcRow = (outH - 1 - r) / scale;
    const r0 = Math.max(0, Math.min(ny - 1, Math.floor(srcRow)));
    const r1 = Math.max(0, Math.min(ny - 1, r0 + 1));
    const fr = srcRow - Math.floor(srcRow);

    for (let c = 0; c < outW; c++) {
      const srcCol = c / scale;
      const c0 = Math.max(0, Math.min(nx - 1, Math.floor(srcCol)));
      const c1 = Math.max(0, Math.min(nx - 1, c0 + 1));
      const fc = srcCol - Math.floor(srcCol);

      // Continuous bilinear sampling of the underlying scalar field
      const v00 = source[r0 * nx + c0] as number;
      const v10 = source[r0 * nx + c1] as number;
      const v01 = source[r1 * nx + c0] as number;
      const v11 = source[r1 * nx + c1] as number;

      let v: number;
      if (kind === "raster-arrival") {
        let sum = 0;
        let wSum = 0;
        const w00 = (1 - fc) * (1 - fr); if (v00 >= 0) { sum += v00 * w00; wSum += w00; }
        const w10 = fc * (1 - fr);       if (v10 >= 0) { sum += v10 * w10; wSum += w10; }
        const w01 = (1 - fc) * fr;       if (v01 >= 0) { sum += v01 * w01; wSum += w01; }
        const w11 = fc * fr;             if (v11 >= 0) { sum += v11 * w11; wSum += w11; }
        v = wSum > 0.4 ? sum / wSum : -1;
      } else {
        const val00 = Number.isFinite(v00) && v00 > 0 ? v00 : 0;
        const val10 = Number.isFinite(v10) && v10 > 0 ? v10 : 0;
        const val01 = Number.isFinite(v01) && v01 > 0 ? v01 : 0;
        const val11 = Number.isFinite(v11) && v11 > 0 ? v11 : 0;
        v = (1 - fc) * (1 - fr) * val00 + fc * (1 - fr) * val10 + (1 - fc) * fr * val01 + fc * fr * val11;
      }

      const o = (r * outW + c) * 4;
      let colour: [number, number, number, number];
      switch (kind) {
        case "raster-maxDepth":
        case "raster-depthNow":
          colour = depthColour(kind === "raster-depthNow" ? v / 100 : v);
          break;
        case "raster-arrival":
          colour = arrivalColour(v, opts.arrivalMaxS);
          break;
        case "raster-velocity":
          colour = velocityColour(v, opts.velocityMax);
          break;
        case "raster-damage":
          colour = damageColour(v);
          break;
        default:
          colour = hazardColour(Math.round(v));
      }
      px[o] = colour[0];
      px[o + 1] = colour[1];
      px[o + 2] = colour[2];
      px[o + 3] = colour[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Hillshade from the DEM grid. */
export function paintHillshade(grid: Grid): string {
  const { nx, ny, dx, z } = grid;
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(nx, ny);
  const px = img.data;
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const rr = ny - 1 - r;
      const i = rr * nx + c;
      const e = z[rr * nx + Math.min(nx - 1, c + 1)];
      const w = z[rr * nx + Math.max(0, c - 1)];
      const n = z[Math.min(ny - 1, rr + 1) * nx + c];
      const s = z[Math.max(0, rr - 1) * nx + c];
      const dzdx = (e - w) / (2 * dx);
      const dzdy = (n - s) / (2 * dx);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, dzdy);
      let shade = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
      shade = Math.max(0, Math.min(1, shade));
      const v = Math.round(30 + 190 * shade);
      const o = (r * nx + c) * 4;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Upsample with high-quality bicubic smoothing so water renders as a continuous,
  // fluid gradient with zero raster pixelation.
  const scale = Math.max(2, Math.min(4, Math.round(600 / Math.max(nx, ny))));
  if (scale > 1) {
    const smoothCanvas = document.createElement("canvas");
    smoothCanvas.width = nx * scale;
    smoothCanvas.height = ny * scale;
    const sCtx = smoothCanvas.getContext("2d")!;
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = "high";
    sCtx.drawImage(canvas, 0, 0, smoothCanvas.width, smoothCanvas.height);
    return smoothCanvas.toDataURL("image/png");
  }
  return canvas.toDataURL("image/png");
}

/** Four corner coordinates [TL, TR, BR, BL] in lon/lat for a MapLibre image source. */
export function gridCorners(grid: Grid): [[number, number], [number, number], [number, number], [number, number]] {
  const { nx, ny, dx, x0, y0, crs } = grid;
  const west = x0 - dx / 2;
  const east = x0 + (nx - 0.5) * dx;
  const south = y0 - dx / 2;
  const north = y0 + (ny - 0.5) * dx;
  const toLL = (x: number, y: number): [number, number] => {
    const lat = crs.lat0 + y / 110900;
    const mPerLon = 111320 * Math.cos((lat * Math.PI) / 180);
    return [crs.lon0 + x / mPerLon, lat];
  };
  return [toLL(west, north), toLL(east, north), toLL(east, south), toLL(west, south)];
}

/** Adds or updates a raster image layer. */
export function setRasterLayer(
  map: MapLibreMap,
  id: RasterLayerId,
  dataUrl: string,
  grid: Grid,
  opacity: number,
  visible: boolean,
) {
  const srcId = `${id}-src`;
  const corners = gridCorners(grid);
  if (map.getSource(srcId)) {
    const src = map.getSource(srcId) as any;
    src.updateImage({ url: dataUrl, coordinates: corners });
  } else {
    map.addSource(srcId, { type: "image", url: dataUrl, coordinates: corners });
    // Insert below labels but above the basemap.
    const before = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id,
        type: "raster",
        source: srcId,
        paint: {
          "raster-opacity": opacity,
          "raster-fade-duration": 0,
          // Linear, not nearest: a 12 m grid blown up to screen resolution looks like
          // confetti with nearest-neighbour sampling, and the whole point of this layer is a
          // continuous field.
          "raster-resampling": "linear",
        },
      },
      before,
    );
  }
  if (map.getLayer(id)) {
    map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    map.setPaintProperty(id, "raster-opacity", opacity);
  }
}

export function removeRasterLayer(map: MapLibreMap, id: RasterLayerId) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(`${id}-src`)) map.removeSource(`${id}-src`);
}

export { DEPTH_CLASSES, HAZARD_CLASSES };
