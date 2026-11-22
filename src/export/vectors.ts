/**
 * Damage-band and flow-direction vector exports.
 *
 * Formats:
 *   - GeoJSON  (universal, and what GIS users expect first)
 *   - KML      (standalone, opens in Google Earth — no zip required)
 *   - KMZ      (KML + a legend PNG, for clean delivery)
 *   - SHP      (real ESRI shapefile bundle, zipped: .shp + .shx + .dbf + .prj + .cpg)
 *   - DXF      (optional CAD exchange; LWPOLYLINE + LINE with layer names)
 *
 * The shapefile writer is implemented here rather than pulled from a dependency: the format
 * needed is a narrow subset (polygons and polylines, one attribute table) and 2 000 lines of
 * generic library would be a poor trade for a few hundred lines of well-documented struct
 * packing. Both writers are exercised by unit tests that round-trip the binary.
 */
import JSZip from "jszip";
import { damageContours, type ContourBand } from "../analysis/contours";
import { unproject } from "../engine/geo";
import type { FlowField, SimulationResult } from "../engine/types";

const DISCLAIMER =
  "Screening-level modelled result. Not a design-grade dam-break study. Depth/damage classes are modelled, not observed; verify with a licensed hydraulic engineer. No area is labelled safe or unsafe by this tool.";

const DAMAGE_LABEL: Record<number, string> = { 0: "none", 1: "low", 2: "medium", 3: "high" };
const CLASS_OF: Record<ContourBand["id"], number> = { low: 1, medium: 2, high: 3 };

export interface VectorExportOptions {
  result: SimulationResult;
  areaKm2: number;
  generatedUtc?: string;
  appVersion?: string;
  /** Rasterise the polygons? Kept for symmetry with the raster exports. */
  includeFlowVectors?: boolean;
}

// ---------------------------------------------------------------- geometry helpers

/** Boundary square ring (lon/lat), the assessment area the user asked for. */
export function boundaryRing(result: SimulationResult, areaKm2: number): number[][] {
  const { nx, ny, dx, x0, y0, crs } = result.grid;
  const half = Math.sqrt(Math.max(0.0001, areaKm2) * 1e6) / 2;
  const cx = x0 + ((nx - 1) / 2) * dx;
  const cy = y0 + ((ny - 1) / 2) * dx;
  const toLL = (x: number, y: number): number[] => {
    const ll = unproject(x, y, crs);
    return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
  };
  return [
    toLL(cx - half, cy - half),
    toLL(cx + half, cy - half),
    toLL(cx + half, cy + half),
    toLL(cx - half, cy + half),
    toLL(cx - half, cy - half),
  ];
}

// ---------------------------------------------------------------- GeoJSON

interface Feature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

export function buildDamageGeoJson(o: VectorExportOptions): string {
  const { result, areaKm2 } = o;
  const cellArea = result.grid.dx * result.grid.dx;
  const cellCount = new Int32Array(4);
  const area = new Float64Array(4);
  for (let i = 0; i < result.damageClass.length; i++) {
    const cls = result.damageClass[i];
    if (cls > 0) {
      cellCount[cls]++;
      area[cls] += cellArea;
    }
  }

  // Contours, not per-cell rectangles: an export that does not look like the map is a trap
  // for whoever opens it next.
  const bands = damageContours(result);
  const features: Feature[] = bands.flatMap((band) =>
    band.polygons.map((poly) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon", coordinates: poly },
      properties: {
        layer: "damage",
        damage: DAMAGE_LABEL[CLASS_OF[band.id]],
        damage_class: CLASS_OF[band.id],
        area_m2: Number((band.areaM2 / Math.max(1, band.polygons.length)).toFixed(1)),
        area_km2: Number((band.areaM2 / Math.max(1, band.polygons.length) / 1e6).toFixed(6)),
      },
    })),
  );

  // Boundary outline as its own feature so the assessed area is explicit in GIS.
  features.push({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [boundaryRing(result, areaKm2)] },
    properties: { layer: "boundary", area_km2: areaKm2, note: "Assessment boundary — reporting only, not a flow barrier" },
  });

  // Real Flow Network (Connected dendritic drainage corridors)
  if (result.flow.flowNetwork && result.flow.flowNetwork.length > 0) {
    for (const b of result.flow.flowNetwork) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: b.path },
        properties: {
          layer: "flow_network",
          role: b.role,
          order: b.order,
          label: b.label,
          bearing_deg: b.bearingDeg,
          length_m: b.lengthM,
          width_m: b.widthM,
          speed_ms: b.speedMs,
          flux: b.flux,
          damage_level: b.damageLevel,
        },
      });
    }
  }

  // Flow nodes (breach origin, bifurcation junctions, hazard basin receptors)
  if (result.flow.nodes && result.flow.nodes.length > 0) {
    for (const n of result.flow.nodes) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: n.lngLat },
        properties: {
          layer: "flow_node",
          id: n.id,
          role: n.role,
          label: n.label,
        },
      });
    }
  }

  if (o.includeFlowVectors !== false) {
    if (result.flow.streamlines && result.flow.streamlines.length > 0) {
      for (const s of result.flow.streamlines) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: s.path },
          properties: {
            layer: "flow_streamline",
            role: s.role,
            direction: s.label,
            bearing_deg: s.headBearingDeg,
            length_m: s.lengthM,
            width_m: s.widthM,
            speed_ms: s.speedMs,
            damage_level: s.damageLevel,
          },
        });
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [s.arrowHead] },
          properties: {
            layer: "flow_arrowhead",
            role: s.role,
            direction: s.label,
            bearing_deg: s.headBearingDeg,
          },
        });
      }
    } else if (result.flow.primaryArrow) {
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [result.flow.primaryArrow.polygon] },
        properties: {
          layer: "primary_flow_arrow",
          role: "primary",
          direction: result.flow.primaryArrow.label,
          bearing_deg: result.flow.primaryArrow.bearingDeg,
          length_m: result.flow.primaryArrow.lengthM,
          width_m: result.flow.primaryArrow.widthM,
          speed_ms: result.flow.primaryArrow.speedMs,
          damage_level: result.flow.primaryArrow.damageLevel,
        },
      });
    }
    for (const v of result.flow.vectors) {
      const len = 0.00012 + 0.00025 * Math.min(1, v.speedMs / Math.max(0.2, result.flow.speedP95Ms));
      const rad = (v.dirDeg * Math.PI) / 180;
      const dLat = len * Math.cos(rad);
      const dLon = (len * Math.sin(rad)) / Math.cos((v.lat * Math.PI) / 180);
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[v.lng, v.lat], [Number((v.lng + dLon).toFixed(7)), Number((v.lat + dLat).toFixed(7))]] },
        properties: {
          layer: "flow",
          direction_deg: Number(v.dirDeg.toFixed(1)),
          direction: compass(v.dirDeg),
          speed_ms: Number(v.speedMs.toFixed(3)),
          depth_m: Number(v.depthM.toFixed(3)),
          flux_m2s: Number(v.flux.toFixed(4)),
        },
      });
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [result.flow.vectors[0]?.lng ?? result.grid.crs.lon0, result.flow.vectors[0]?.lat ?? result.grid.crs.lat0] },
      properties: { layer: "flow_summary", ...flowSummaryProps(result.flow) },
    });
  }

  return JSON.stringify(
    {
      type: "FeatureCollection",
      name: "TankBreach damage bands and flow directions",
      metadata: {
        app: `TankBreach v${o.appVersion ?? "0.1.0"}`,
        generatedUtc: o.generatedUtc ?? new Date().toISOString(),
        runHash: result.hash,
        assessmentAreaKm2: areaKm2,
        grid: { nx: result.grid.nx, ny: result.grid.ny, dx_m: result.grid.dx, crs: result.grid.crs.proj4 },
        damageCells: { low: cellCount[1], medium: cellCount[2], high: cellCount[3] },
        damageAreaKm2: {
          low: Number((area[1] / 1e6).toFixed(6)),
          medium: Number((area[2] / 1e6).toFixed(6)),
          high: Number((area[3] / 1e6).toFixed(6)),
        },
        damageMethod: result.damageMethod,
        massBalanceErrorPercent: Number(result.mass.errorPercent.toFixed(3)),
        disclaimer: DISCLAIMER,
      },
      features,
    },
    null,
    1,
  );
}

function compass(deg: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function flowSummaryProps(f: FlowField): Record<string, unknown> {
  return {
    mean_direction_deg: Number(f.meanDirDeg.toFixed(1)),
    mean_direction: compass(f.meanDirDeg),
    dominant_direction: f.dominantLabel,
    dominant_direction_deg: f.dominantDirDeg,
    concentration: Number(f.concentration.toFixed(3)),
    boundary_area_km2: Number((f.boundaryAreaM2 / 1e6).toFixed(6)),
    wet_area_km2: Number((f.boundaryWetAreaM2 / 1e6).toFixed(6)),
    wet_fraction: Number(f.boundaryWetFraction.toFixed(4)),
  };
}

// ---------------------------------------------------------------- KML

const KML_COLOURS: Record<number, string> = {
  1: "5900e0fb", // low    (AABBGGRR) — matches #facc15
  2: "59006cfb", // medium — matches #fb923c
  3: "59002bdc", // high   — matches #dc2626
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildDamageKml(o: VectorExportOptions, opts: { withLegend?: string } = {}): string {
  const { result, areaKm2 } = o;
  const cellArea = result.grid.dx * result.grid.dx;
  const count = new Int32Array(4);
  for (let i = 0; i < result.damageClass.length; i++) count[result.damageClass[i]]++;

  const styles = [1, 2, 3]
    .map(
      (cls) => `    <Style id="damage${cls}">
      <LineStyle><color>ff1a2333</color><width>0.4</width></LineStyle>
      <PolyStyle><color>${KML_COLOURS[cls]}</color></PolyStyle>
    </Style>`,
    )
    .join("\n");

  const bandShapes = damageContours(result);
  const placemarks = bandShapes
    .flatMap((band) => {
      const cls = CLASS_OF[band.id];
      return band.polygons.map((poly, i) => {
        const outer = poly[0].map((p) => `${p[0]},${p[1]},0`).join(" ");
        return `    <Placemark>
      <name>${esc(DAMAGE_LABEL[cls])} damage${band.polygons.length > 1 ? ` (${i + 1})` : ""}</name>
      <styleUrl>#damage${cls}</styleUrl>
      <ExtendedData>
        <Data name="damage"><value>${DAMAGE_LABEL[cls]}</value></Data>
        <Data name="damage_class"><value>${cls}</value></Data>
        <Data name="area_m2"><value>${(band.areaM2 / band.polygons.length).toFixed(0)}</value></Data>
      </ExtendedData>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
      });
    })
    .join("\n");

  const boundary = boundaryRing(result, areaKm2)
    .map((p) => `${p[0]},${p[1]},0`)
    .join(" ");

  const flowPlacemarks =
    o.includeFlowVectors === false
      ? ""
      : result.flow.vectors
          .map((v) => {
            const len = 0.00012 + 0.00025 * Math.min(1, v.speedMs / Math.max(0.2, result.flow.speedP95Ms));
            const rad = (v.dirDeg * Math.PI) / 180;
            const dLat = len * Math.cos(rad);
            const dLon = (len * Math.sin(rad)) / Math.cos((v.lat * Math.PI) / 180);
            return `    <Placemark>
      <name>${esc(compass(v.dirDeg))} ${v.speedMs.toFixed(2)} m/s</name>
      <styleUrl>#flowLine</styleUrl>
      <ExtendedData>
        <Data name="direction"><value>${esc(compass(v.dirDeg))}</value></Data>
        <Data name="direction_deg"><value>${v.dirDeg.toFixed(1)}</value></Data>
        <Data name="speed_ms"><value>${v.speedMs.toFixed(3)}</value></Data>
        <Data name="depth_m"><value>${v.depthM.toFixed(3)}</value></Data>
      </ExtendedData>
      <LineString><tessellate>1</tessellate><coordinates>${v.lng},${v.lat},0 ${(v.lng + dLon).toFixed(7)},${(v.lat + dLat).toFixed(7)},0</coordinates></LineString>
    </Placemark>`;
          })
          .join("\n");

  const legend = opts.withLegend
    ? `  <ScreenOverlay>
    <name>Legend</name>
    <Icon><href>${esc(opts.withLegend)}</href></Icon>
    <overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/>
    <screenXY x="16" y="70" xunits="pixels" yunits="pixels"/>
    <size x="0" y="0" xunits="fraction" yunits="fraction"/>
  </ScreenOverlay>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>TankBreach — damage bands and flow directions</name>
    <description><![CDATA[
      <b>Assessment area:</b> ${areaKm2} km²<br/>
      <b>Method:</b> ${result.damageMethod === "hazard_depth" ? "depth × velocity with depth override" : "depth only (velocities negligible)"}<br/>
      <b>Flow:</b> mean ${compass(result.flow.meanDirDeg)} (${result.flow.meanDirDeg.toFixed(0)}°), dominant ${result.flow.dominantLabel}<br/>
      <b>Run hash:</b> ${result.hash}<br/><br/>
      <span style="color:#c0392b"><b>${esc(DISCLAIMER)}</b></span>
    ]]></description>
${styles}
    <Style id="flowLine">
      <LineStyle><color>ffffffff</color><width>1.6</width></LineStyle>
    </Style>
    <Style id="boundaryStyle">
      <LineStyle><color>ffffffff</color><width>2</width></LineStyle>
      <PolyStyle><color>00000000</color></PolyStyle>
    </Style>
${legend}
    <Folder><name>Assessment boundary (${areaKm2} km²)</name>
    <Placemark>
      <name>Assessment boundary</name>
      <styleUrl>#boundaryStyle</styleUrl>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${boundary}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
    </Folder>
    <Folder><name>Damage bands — low ${count[1]} cells · medium ${count[2]} · high ${count[3]}</name>
${placemarks}
    </Folder>
    <Folder><name>Flow direction — dominant ${result.flow.dominantLabel}</name>
${flowPlacemarks}
    </Folder>
  </Document>
</kml>`;
}

export async function buildDamageKmz(o: VectorExportOptions, legendPng?: string): Promise<Blob> {
  const zip = new JSZip();
  if (legendPng) {
    const base64 = legendPng.split(",")[1] ?? "";
    zip.file("files/legend.png", base64, { base64: true });
  }
  zip.file("doc.kml", buildDamageKml(o, legendPng ? { withLegend: "files/legend.png" } : {}));
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- shapefile

/** Packed little-endian writer used for both the fixed headers and the records. */
class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 0;
  constructor(initial = 1 << 16) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
  }
  private ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.view = new DataView(next);
  }
  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  i32be(v: number) {
    this.ensure(4);
    this.view.setInt32(this.pos, v, false);
    this.pos += 4;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    new Uint8Array(this.buf).set(b, this.pos);
    this.pos += b.length;
  }
  ascii(s: string, len: number) {
    const b = new Uint8Array(len);
    for (let i = 0; i < Math.min(len, s.length); i++) b[i] = s.charCodeAt(i) & 0x7f;
    this.bytes(b);
  }
  result(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }
  get length() {
    return this.pos;
  }
}

/** Shapefile shape types used here. */
const SHAPE_NULL = 0;
const SHAPE_POLYLINE = 3;
const SHAPE_POLYGON = 5;

export type ShapeKind = "polygon" | "polyline";

export interface ShapeRecord {
  /** Rings for polygons, a single part for polylines. Coordinates in lon/lat. */
  parts: number[][][];
  attributes: Record<string, string | number>;
}

export interface ShpField {
  name: string;
  type: "C" | "N" | "F";
  length: number;
  decimals?: number;
}

function bboxOf(records: ShapeRecord[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rec of records) {
    for (const part of rec.parts) {
      for (const [x, y] of part) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/** Writes a .shp for polygons or polylines. Polygons are stored clockwise (shapefile spec). */
export function buildShp(kind: ShapeKind, records: ShapeRecord[]): Uint8Array {
  const shapeType = kind === "polygon" ? SHAPE_POLYGON : SHAPE_POLYLINE;
  const [minX, minY, maxX, maxY] = bboxOf(records);

  const w = new ByteWriter(1 << 16);
  // ---- file header (100 bytes)
  w.i32be(9994); // file code
  for (let i = 0; i < 5; i++) w.i32be(0); // unused
  w.i32be(0); // file length placeholder (16-bit words) — patched below
  w.i32be(1000); // version
  w.i32(shapeType);
  w.f64(minX);
  w.f64(minY);
  w.f64(maxX);
  w.f64(maxY);
  for (let i = 0; i < 4; i++) w.f64(0); // Z/M ranges

  records.forEach((rec, idx) => {
    const points: number[][] = [];
    const partOffsets: number[] = [];
    for (const part of rec.parts) {
      if (part.length === 0) continue;
      partOffsets.push(points.length);
      for (const p of part) points.push(p);
    }
    if (points.length === 0) {
      w.i32be(idx + 1);
      w.i32be(2);
      w.i32(SHAPE_NULL);
      return;
    }
    const contentBytes = 4 + 32 + 4 + 4 + partOffsets.length * 4 + points.length * 16;
    w.i32be(idx + 1);
    w.i32be(contentBytes / 2);
    w.i32(shapeType);
    // per-record bbox
    let rx0 = Infinity;
    let ry0 = Infinity;
    let rx1 = -Infinity;
    let ry1 = -Infinity;
    for (const [x, y] of points) {
      if (x < rx0) rx0 = x;
      if (y < ry0) ry0 = y;
      if (x > rx1) rx1 = x;
      if (y > ry1) ry1 = y;
    }
    w.f64(rx0);
    w.f64(ry0);
    w.f64(rx1);
    w.f64(ry1);
    w.i32(partOffsets.length);
    w.i32(points.length);
    for (const off of partOffsets) w.i32(off);
    for (const [x, y] of points) {
      w.f64(x);
      w.f64(y);
    }
  });

  const out = w.result();
  // Patch the file length (in 16-bit words) at byte offset 24.
  new DataView(out.buffer, out.byteOffset).setInt32(24, out.length / 2, false);
  return out;
}

/** Writes the .shx index matching a .shp. */
export function buildShx(kind: ShapeKind, records: ShapeRecord[]): Uint8Array {
  const shapeType = kind === "polygon" ? SHAPE_POLYGON : SHAPE_POLYLINE;
  const [minX, minY, maxX, maxY] = bboxOf(records);
  const w = new ByteWriter(1 << 12);
  w.i32be(9994);
  for (let i = 0; i < 5; i++) w.i32be(0);
  w.i32be(0); // patched
  w.i32be(1000);
  w.i32(shapeType);
  w.f64(minX);
  w.f64(minY);
  w.f64(maxX);
  w.f64(maxY);
  for (let i = 0; i < 4; i++) w.f64(0);

  let offsetWords = 50; // 100-byte header = 50 words
  records.forEach((rec) => {
    const points = rec.parts.reduce((n, p) => n + p.length, 0);
    const partCount = rec.parts.filter((p) => p.length > 0).length;
    const contentBytes = points === 0 ? 4 : 4 + 32 + 4 + 4 + partCount * 4 + points * 16;
    w.i32be(offsetWords);
    w.i32be(contentBytes / 2);
    offsetWords += (8 + contentBytes) / 2;
  });

  const out = w.result();
  new DataView(out.buffer, out.byteOffset).setInt32(24, out.length / 2, false);
  return out;
}

/** Writes the dBASE III .dbf attribute table. */
export function buildDbf(fields: ShpField[], records: Record<string, string | number>[]): Uint8Array {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, f) => n + f.length, 0);
  const total = headerLen + records.length * recordLen + 1;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const today = new Date();
  view.setUint8(0, 0x03); // dBASE III without memo
  view.setUint8(1, today.getFullYear() - 1900);
  view.setUint8(2, today.getMonth() + 1);
  view.setUint8(3, today.getDate());
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerLen, true);
  view.setUint16(10, recordLen, true);
  view.setUint8(29, 0x57); // language driver

  let p = 32;
  const enc = new TextEncoder();
  for (const f of fields) {
    const name = enc.encode(f.name.slice(0, 10));
    u8.set(name.subarray(0, 11), p);
    u8[p + 11] = f.type.charCodeAt(0);
    u8[p + 16] = f.length;
    u8[p + 17] = f.decimals ?? 0;
    p += 32;
  }
  u8[p] = 0x0d; // header terminator
  p++;

  for (const rec of records) {
    u8[p] = 0x20; // not deleted
    p++;
    for (const f of fields) {
      const raw = rec[f.name];
      let text: string;
      if (f.type === "N" || f.type === "F") {
        const n = typeof raw === "number" ? raw : Number(raw);
        text = Number.isFinite(n) ? n.toFixed(f.decimals ?? 0) : "";
        text = text.padStart(f.length, " ").slice(-f.length);
      } else {
        text = String(raw ?? "");
        // dBASE strings are padded with spaces and truncated to the field width.
        text = text.slice(0, f.length).padEnd(f.length, " ");
      }
      for (let i = 0; i < f.length; i++) u8[p + i] = text.charCodeAt(i) & 0xff;
      p += f.length;
    }
  }
  u8[p] = 0x1a; // EOF
  return u8;
}

const PRJ_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

export interface ShapefileBundle {
  blob: Blob;
  filename: string;
}

/**
 * Builds a zipped ESRI shapefile set:
 *   damage_bands.shp/.shx/.dbf/.prj/.cpg   — three-band damage polygons
 *   flow_direction.shp/.shx/.dbf/.prj/.cpg — flow arrows as lines
 *   boundary.shp/...                       — the assessment square
 */
export async function buildDamageShapefile(o: VectorExportOptions): Promise<ShapefileBundle> {
  const { result, areaKm2 } = o;
  const cellArea = result.grid.dx * result.grid.dx;
  const zip = new JSZip();

  // ---- damage polygons (clockwise rings, per shapefile spec)
  const bandShapes = damageContours(result);
  const damageRecords: ShapeRecord[] = bandShapes.flatMap((band) => {
    const cls = CLASS_OF[band.id];
    return band.polygons.map((poly) => ({
      // Shapefile polygons must be clockwise; GeoJSON rings are counter-clockwise.
      parts: [poly[0].slice().reverse()],
      attributes: {
        DAMAGE: DAMAGE_LABEL[cls],
        CLASS: cls,
        AREA_M2: Math.round(band.areaM2 / band.polygons.length),
        CELLS: Math.round(band.areaM2 / cellArea / band.polygons.length),
        RUN_HASH: result.hash.slice(0, 10),
      },
    }));
  });
  const damageFields: ShpField[] = [
    { name: "DAMAGE", type: "C", length: 10 },
    { name: "CLASS", type: "N", length: 2 },
    { name: "AREA_M2", type: "N", length: 14, decimals: 0 },
    { name: "CELLS", type: "N", length: 8 },
    { name: "RUN_HASH", type: "C", length: 12 },
  ];

  zip.file("damage_bands.shp", buildShp("polygon", damageRecords));
  zip.file("damage_bands.shx", buildShx("polygon", damageRecords));
  zip.file("damage_bands.dbf", buildDbf(damageFields, damageRecords.map((r) => r.attributes)));
  zip.file("damage_bands.prj", PRJ_WGS84);
  zip.file("damage_bands.cpg", "UTF-8");

  // ---- flow arrows
  if (o.includeFlowVectors !== false) {
    const flowRecords: ShapeRecord[] = result.flow.vectors.map((v) => {
      const len = 0.00012 + 0.00025 * Math.min(1, v.speedMs / Math.max(0.2, result.flow.speedP95Ms));
      const rad = (v.dirDeg * Math.PI) / 180;
      const dLat = len * Math.cos(rad);
      const dLon = (len * Math.sin(rad)) / Math.cos((v.lat * Math.PI) / 180);
      return {
        parts: [[[v.lng, v.lat], [Number((v.lng + dLon).toFixed(7)), Number((v.lat + dLat).toFixed(7))]]],
        attributes: {
          DIR_DEG: Number(v.dirDeg.toFixed(1)),
          DIR: compass(v.dirDeg),
          SPEED_MS: Number(v.speedMs.toFixed(3)),
          DEPTH_M: Number(v.depthM.toFixed(3)),
          FLUX_M2S: Number(v.flux.toFixed(4)),
        },
      };
    });
    const flowFields: ShpField[] = [
      { name: "DIR_DEG", type: "N", length: 6, decimals: 1 },
      { name: "DIR", type: "C", length: 3 },
      { name: "SPEED_MS", type: "N", length: 8, decimals: 3 },
      { name: "DEPTH_M", type: "N", length: 8, decimals: 3 },
      { name: "FLUX_M2S", type: "N", length: 10, decimals: 4 },
    ];
    zip.file("flow_direction.shp", buildShp("polyline", flowRecords));
    zip.file("flow_direction.shx", buildShx("polyline", flowRecords));
    zip.file("flow_direction.dbf", buildDbf(flowFields, flowRecords.map((r) => r.attributes)));
    zip.file("flow_direction.prj", PRJ_WGS84);
    zip.file("flow_direction.cpg", "UTF-8");
  }

  // ---- assessment boundary
  const boundaryRec: ShapeRecord[] = [
    {
      parts: [[...boundaryRing(result, areaKm2)].reverse()],
      attributes: { AREA_KM2: areaKm2, RUN_HASH: result.hash.slice(0, 10) },
    },
  ];
  const boundaryFields: ShpField[] = [
    { name: "AREA_KM2", type: "N", length: 12, decimals: 4 },
    { name: "RUN_HASH", type: "C", length: 12 },
  ];
  zip.file("boundary.shp", buildShp("polygon", boundaryRec));
  zip.file("boundary.shx", buildShx("polygon", boundaryRec));
  zip.file("boundary.dbf", buildDbf(boundaryFields, boundaryRec.map((r) => r.attributes)));
  zip.file("boundary.prj", PRJ_WGS84);
  zip.file("boundary.cpg", "UTF-8");

  zip.file(
    "README.txt",
    [
      "TankBreach — damage bands and flow directions",
      `Generated: ${o.generatedUtc ?? new Date().toISOString()}`,
      `Run hash: ${result.hash}`,
      `Assessment boundary: ${areaKm2} km²`,
      `Damage method: ${result.damageMethod}`,
      "",
      "damage_bands.*  Low / medium / high damage polygons (dissolved into rectangles).",
      "flow_direction.* Flow arrows: DIR_DEG is the compass bearing the water travels towards,",
      "                SPEED_MS the depth-averaged outgoing speed, FLUX_M2S the speed x depth.",
      "boundary.*      The assessment area. Reporting only — the model routes beyond it.",
      "",
      `Flow summary: mean ${compass(result.flow.meanDirDeg)} (${result.flow.meanDirDeg.toFixed(0)}°),`,
      `dominant ${result.flow.dominantLabel}, concentration ${result.flow.concentration.toFixed(2)}.`,
      "",
      DISCLAIMER,
    ].join("\n"),
  );

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { blob, filename: `tankbreach_vectors_${result.hash}.zip` };
}

// ---------------------------------------------------------------- DXF

/** Minimal ASCII DXF with one layer per damage band plus a flow layer. */
export function buildDxf(o: VectorExportOptions): string {
  const { result, areaKm2 } = o;
  const layerName = (cls: number) => (cls === 1 ? "DAMAGE_LOW" : cls === 2 ? "DAMAGE_MEDIUM" : "DAMAGE_HIGH");
  const lines: string[] = [];

  lines.push("0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "6", "0", "ENDSEC");
  lines.push("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", "5");
  for (const [name, colour] of [
    ["DAMAGE_LOW", 2],
    ["DAMAGE_MEDIUM", 30],
    ["DAMAGE_HIGH", 1],
    ["FLOW", 7],
    ["BOUNDARY", 4],
  ] as [string, number][]) {
    lines.push("0", "LAYER", "2", name, "70", "0", "62", String(colour), "6", "CONTINUOUS");
  }
  lines.push("0", "ENDTAB", "0", "ENDSEC");

  lines.push("0", "SECTION", "2", "ENTITIES");
  for (const band of damageContours(result)) {
    const cls = CLASS_OF[band.id];
    for (const poly of band.polygons) {
      const ring = poly[0];
      lines.push("0", "LWPOLYLINE", "8", layerName(cls), "90", String(ring.length), "70", "1");
      for (const [x, y] of ring) lines.push("10", x.toFixed(7), "20", y.toFixed(7));
    }
  }
  const boundary = boundaryRing(result, areaKm2);
  lines.push("0", "LWPOLYLINE", "8", "BOUNDARY", "90", String(boundary.length), "70", "1");
  for (const [x, y] of boundary) lines.push("10", x.toFixed(7), "20", y.toFixed(7));

  for (const v of result.flow.vectors) {
    const len = 0.00012 + 0.00025 * Math.min(1, v.speedMs / Math.max(0.2, result.flow.speedP95Ms));
    const rad = (v.dirDeg * Math.PI) / 180;
    const dLat = len * Math.cos(rad);
    const dLon = (len * Math.sin(rad)) / Math.cos((v.lat * Math.PI) / 180);
    lines.push(
      "0",
      "LINE",
      "8",
      "FLOW",
      "10",
      v.lng.toFixed(7),
      "20",
      v.lat.toFixed(7),
      "11",
      (v.lng + dLon).toFixed(7),
      "21",
      (v.lat + dLat).toFixed(7),
    );
  }
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\r\n");
}
