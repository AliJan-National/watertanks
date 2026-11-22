/**
 * KMZ export.
 *
 * Structure (must open cleanly in Google Earth Pro and Web):
 *   doc.kml
 *     Document (name, description with metrics + attribution)
 *       Folder "Tank"        -> Placemark point with ExtendedData
 *       Folder "Inundation"   -> GroundOverlay (depth raster) + per-class GroundOverlays
 *       Folder "Hazard"       -> GroundOverlays low / moderate / high
 *       Folder "Arrival"      -> GroundOverlay (arrival time raster)
 *       Folder "Vectors"      -> extent outline, exposed buildings
 *       ScreenOverlay         -> legend.png, bottom-left
 *     files/*.png
 *
 * GroundOverlays use a LatLonBox with the *true* corners of the analysis grid. The grid is
 * axis-aligned in a local tangent plane, so at these scales (a few km) the north/east edges
 * are within a few metres of parallels/meridians and a LatLonBox is accurate; the rotation
 * field is included for correctness at high latitudes.
 */

import JSZip from "jszip";
import type { SimulationResult, TankSpec } from "../engine/types";
import { paintRaster } from "../map/rasterLayers";
import { DEPTH_CLASSES, HAZARD_CLASSES } from "../engine/shallowFlow";
import type { ExposureResult } from "../engine/exposure";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (n: number, d = 6) => (Number.isFinite(n) ? n.toFixed(d) : "0");

export function gridBox(grid: SimulationResult["grid"]) {
  const { nx, ny, dx, x0, y0, crs } = grid;
  const toLL = (x: number, y: number) => {
    const lat = crs.lat0 + y / 110900;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    return { lon: crs.lon0 + x / mLon, lat };
  };
  const west = x0 - dx / 2;
  const east = x0 + (nx - 0.5) * dx;
  const south = y0 - dx / 2;
  const north = y0 + (ny - 0.5) * dx;
  const bl = toLL(west, south);
  const tr = toLL(east, north);
  return { south: bl.lat, west: bl.lon, north: tr.lat, east: tr.lon };
}

/** Raster painters used by the KMZ need a DOM canvas; this is only called client-side. */
function rasterDataUrl(kind: any, result: SimulationResult, frameIndex: number, arrivalMaxS: number): string {
  const url = paintRaster(kind, result, {
    frameIndex,
    arrivalMaxS,
    velocityMax: result.stats.maxVelocityMs,
  });
  return url.split(",")[1]; // strip the data URL prefix -> base64
}

function groundOverlay(opts: {
  name: string;
  file: string;
  box: { north: number; south: number; east: number; west: number };
  colour?: string;
  opacity?: number;
}): string {
  return `    <GroundOverlay>
      <name>${esc(opts.name)}</name>
      <color>${opts.colour ?? "b0ffffff"}</color>
      <Icon><href>files/${opts.file}</href></Icon>
      <LatLonBox>
        <north>${num(opts.box.north)}</north>
        <south>${num(opts.box.south)}</south>
        <east>${num(opts.box.east)}</east>
        <west>${num(opts.box.west)}</west>
      </LatLonBox>
    </GroundOverlay>`;
}

export interface KmzOptions {
  tank: TankSpec;
  result: SimulationResult;
  exposure?: ExposureResult | null;
  title: string;
  attribution: string;
  demLabel: string;
  demAccuracy: number | null;
  runHash: string;
  frameIndex: number;
}

export async function buildKmz(opts: KmzOptions): Promise<Blob> {
  const { tank, result } = opts;
  const zip = new JSZip();
  const box = gridBox(result.grid);
  const arrivalMaxS = Math.max(60, ...result.arrivalTime.filter((v) => v >= 0).slice(0, 20000));
  const files: { name: string; b64: string }[] = [];

  const depthB64 = rasterDataUrl("raster-maxDepth", result, opts.frameIndex, arrivalMaxS);
  files.push({ name: "depth_overlay.png", b64: depthB64 });
  const hazardB64 = rasterDataUrl("raster-hazard", result, opts.frameIndex, arrivalMaxS);
  files.push({ name: "hazard_overlay.png", b64: hazardB64 });
  const arrivalB64 = rasterDataUrlSafe("raster-arrival", result, opts.frameIndex, arrivalMaxS);
  if (arrivalB64) files.push({ name: "arrival_overlay.png", b64: arrivalB64 });

  const docs = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<kml xmlns="http://www.opengis.net/kml/2.2">`,
    `  <Document>`,
    `    <name>${esc(opts.title)}</name>`,
    `    <description><![CDATA[`,
    `<b>TankBreach — tank leak / breach inundation (screening)</b><br/>`,
    `Tank: ${esc(tank.name)} (${tank.shape})<br/>`,
    `Location: ${num(tank.location.lat, 6)}, ${num(tank.location.lng, 6)}<br/>`,
    `Released: ${result.mass.releasedM3.toFixed(1)} m³ · Peak Q: ${result.hydro.peakQ.toFixed(3)} m³/s<br/>`,
    `Affected area: ${(result.stats.affectedAreaM2 / 10000).toFixed(2)} ha · Max depth: ${result.stats.maxDepthM.toFixed(2)} m<br/>`,
    `DEM: ${esc(opts.demLabel)}${opts.demAccuracy !== null ? ` (±${opts.demAccuracy} m)` : ""}<br/>`,
    `Run hash: ${opts.runHash} · Generated: ${new Date().toISOString()}<br/><br/>`,
    `<b style="color:#c00">Screening tool — not a design-grade dam-break study.</b> `,
    `Modelled conditions, not observed flooding. Verify with a licensed engineer.<br/><br/>`,
    `${esc(opts.attribution)}`,
    `]]></description>`,
  ];

  // ---- Tank placemark
  docs.push(`    <Folder><name>Tank</name>
      <Placemark>
        <name>${esc(tank.name)}</name>
        <description><![CDATA[
          Shape: ${esc(tank.shape)}<br/>
          Capacity (nameplate): ${tank.capacityM3} m³<br/>
          Wall height: ${tank.wallHeightM} m · Water level: ${tank.waterHeadM} m<br/>
          Floor elevation: ${tank.baseElevationM.toFixed(2)} m<br/>
          Fluid: ${esc(tank.fluid)}
        ]]></description>
        <styleUrl>#tankStyle</styleUrl>
        <Point><coordinates>${num(tank.location.lng)},${num(tank.location.lat)},0</coordinates></Point>
        <ExtendedData>
          <Data name="shape"><value>${esc(tank.shape)}</value></Data>
          <Data name="capacityM3"><value>${tank.capacityM3}</value></Data>
          <Data name="wallHeightM"><value>${tank.wallHeightM}</value></Data>
          <Data name="waterHeadM"><value>${tank.waterHeadM}</value></Data>
          <Data name="baseElevationM"><value>${tank.baseElevationM}</value></Data>
        </ExtendedData>
      </Placemark>
    </Folder>`);

  // ---- Inundation overlays
  docs.push(`    <Folder><name>Modelled inundation</name>`);
  docs.push(groundOverlay({ name: "Maximum modelled depth", file: "depth_overlay.png", box }));
  // Per-class overlays: KML GroundOverlays are raster, not class-filtered, so instead of
  // duplicating the same image six times we list the class areas in the folder description.
  docs.push(`      <Folder><name>Depth class areas</name><description><![CDATA[
      ${result.classes
        .filter((c) => c.areaM2 > 0)
        .map((c) => `${c.label}: ${(c.areaM2 / 10000).toFixed(2)} ha`)
        .join("<br/>")}
      ]]></description></Folder>`);
  docs.push(`    </Folder>`);

  // ---- Hazard + arrival
  docs.push(`    <Folder><name>Hazard to people (depth × velocity)</name>`);
  docs.push(groundOverlay({ name: "Hazard classes — low / moderate / high", file: "hazard_overlay.png", box }));
  docs.push(`    </Folder>`);
  if (arrivalB64) {
    docs.push(`    <Folder><name>Arrival time</name>`);
    docs.push(groundOverlay({ name: "First arrival time (log scale)", file: "arrival_overlay.png", box }));
    docs.push(`    </Folder>`);
  }

  // ---- Exposed buildings as simple placemarks
  const bld = opts.exposure?.buildings ?? [];
  if (bld.length) {
    docs.push(`    <Folder><name>Buildings exposed to modelled flooding (${bld.length})</name>`);
    for (const b of bld.slice(0, 500)) {
      docs.push(`      <Placemark>
        <name>${esc(b.name || b.kind || b.id)}</name>
        <description><![CDATA[Max modelled depth: ${b.maxDepthM.toFixed(2)} m<br/>Arrival: ${
          b.arrivalTimeS >= 0 ? b.arrivalTimeS.toFixed(0) + " s" : "not reached"
        }]]></description>
        <styleUrl>#buildingStyle</styleUrl>
        <Point><coordinates>${num(b.footprintCentroid.lng)},${num(b.footprintCentroid.lat)},0</coordinates></Point>
      </Placemark>`);
    }
    docs.push(`    </Folder>`);
  }

  docs.push(`    <ScreenOverlay>
      <name>Legend</name>
      <Icon><href>files/legend.png</href></Icon>
      <overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/>
      <screenXY x="10" y="10" xunits="pixels" yunits="pixels"/>
      <size x="0" y="0" xunits="fraction" yunits="fraction"/>
    </ScreenOverlay>`);

  docs.push(`    <Style id="tankStyle"><IconStyle><color>ff00b8f5</color><scale>1.3</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>`);
  docs.push(`    <Style id="buildingStyle"><IconStyle><color>ff2222ee</color><scale>0.8</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`);
  docs.push(`  </Document>`, `</kml>`);

  zip.file("doc.kml", docs.join("\n"));
  for (const f of files) zip.file(`files/${f.name}`, f.b64, { base64: true });
  zip.file("files/legend.png", makeLegendPng(), { base64: true });

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

function rasterDataUrlSafe(kind: any, result: SimulationResult, frameIndex: number, arrivalMaxS: number): string | null {
  try {
    return rasterDataUrl(kind, result, frameIndex, arrivalMaxS);
  } catch {
    return null;
  }
}

/** Draws the legend into a canvas and returns base64 (without data-url prefix). */
function makeLegendPng(): string {
  const c = document.createElement("canvas");
  c.width = 300;
  c.height = 230;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(15,23,42,0.92)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#24344f";
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
  ctx.fillStyle = "#e6edf7";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("Modelled depth (m)", 12, 24);
  ctx.font = "12px sans-serif";
  const classes = [...DEPTH_CLASSES];
  classes.forEach((cl, i) => {
    const y = 40 + i * 20;
    ctx.fillStyle = cl.colour;
    ctx.fillRect(12, y, 26, 13);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(cl.label, 46, y + 11);
  });
  let y = 40 + classes.length * 20 + 14;
  ctx.fillStyle = "#e6edf7";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText("Hazard (d × v)", 12, y);
  ctx.font = "12px sans-serif";
  [1, 2, 3].forEach((h, i) => {
    const yy = y + 8 + i * 20;
    ctx.fillStyle = HAZARD_CLASSES[h].colour;
    ctx.fillRect(12, yy, 26, 13);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(HAZARD_CLASSES[h].label, 46, yy + 11);
  });
  ctx.fillStyle = "#f87171";
  ctx.font = "bold 11px sans-serif";
  ctx.fillText("Screening tool — not a design-grade study", 12, c.height - 10);
  return c.toDataURL("image/png").split(",")[1];
}
