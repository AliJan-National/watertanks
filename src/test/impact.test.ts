/**
 * Tests for the impact boundary, the three damage bands, the flow-direction field and the
 * vector writers (GeoJSON / KML / real shapefile binary).
 *
 * The shapefile tests parse the bytes back rather than trusting the writer: a header offset or
 * big-endian/little-endian slip produces a file that some readers open and others silently
 * reject, which is exactly the failure this suite exists to catch.
 */
import { describe, expect, it } from "vitest";
import { analyseDamage, analyseFlow, boundaryHalfWidthM, DEFAULT_THRESHOLDS } from "../analysis/impact";
import { buildDbf, buildShp, buildShx } from "../export/vectors";
import { makeLocalCRS } from "../engine/geo";
import type { SimulationResult } from "../engine/types";

const DX = 10;
const NX = 120;
const NY = 120;
const crs = makeLocalCRS(39.6111, 24.4672);

/** Synthetic result: a wet blob centred on the tank, plus a uniform eastward drift. */
function makeResult(wetRadiusCells = 10, velocity = 0.8): SimulationResult {
  const n = NX * NY;
  const maxDepth = new Float32Array(n);
  const maxVelocity = new Float32Array(n);
  const cx = (NX - 1) / 2;
  const cy = (NY - 1) / 2;
  for (let r = 0; r < NY; r++) {
    for (let c = 0; c < NX; c++) {
      const d = Math.hypot(c - cx, r - cy);
      if (d <= wetRadiusCells) {
        const i = r * NX + c;
        maxDepth[i] = 1.2 * (1 - d / wetRadiusCells) + 0.02;
        maxVelocity[i] = velocity;
      }
    }
  }
  return {
    tankGroundElevationM: null,
    hydro: {
      points: [],
      peakQ: 0,
      peakQTimeS: 0,
      totalVolumeM3: 2000,
      emptyTimeS: 0,
      stopReason: "empty",
      residualVolumeM3: 0,
      method: "orifice",
    },
    maxDepth,
    arrivalTime: new Float32Array(n).fill(30),
    maxVelocity,
    wetDuration: new Float32Array(n).fill(600),
    frames: [],
    frameTimes: [],
    frameStats: [],
    depthClass: new Uint8Array(n),
    hazardClass: new Uint8Array(n),
    mass: {
      releasedM3: 2000,
      wetM3: 2000,
      infiltrationM3: 0,
      outflowM3: 0,
      tankResidualM3: 0,
      errorM3: 0,
      clampedM3: 0,
      errorPercent: 0.1,
      ok: true,
    },
    classes: [],
    stats: {
      affectedAreaM2: 0,
      maxDepthM: 0,
      meanDepthAffectedM: 0,
      maxVelocityMs: 0,
      maxExtentDistanceM: 0,
      firstArrivalS: 0,
      peakDepthTimeS: 0,
      wetCellCount: 0,
    },
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
    grid: {
      nx: NX,
      ny: NY,
      dx: DX,
      x0: -(NX / 2) * DX,
      y0: -(NY / 2) * DX,
      z: new Float32Array(n),
      crs,
    } as SimulationResult["grid"],
    options: {} as SimulationResult["options"],
    computeMs: 0,
    hash: "testhash",
    warnings: [],
  };
}

describe("impact boundary", () => {
  it("half-width matches the requested area", () => {
    expect(boundaryHalfWidthM(1)).toBeCloseTo(500, 6);
    expect(boundaryHalfWidthM(4)).toBeCloseTo(1000, 6);
  });

  it("a larger boundary can only include more cells, never fewer", () => {
    const result = makeResult(30);
    const small = analyseDamage(result, 0.25);
    const large = analyseDamage(result, 4);
    expect(large.cellsInside).toBeGreaterThan(small.cellsInside);
    const totalOf = (a: typeof small) => a.bands.reduce((n, b) => n + b.cellCount, 0);
    expect(totalOf(large)).toBeGreaterThanOrEqual(totalOf(small));
    expect(large.bands.reduce((n, b) => n + b.cellCount, 0)).toBeLessThanOrEqual(NX * NY);
  });

  it("cells outside the boundary are never classified", () => {
    const result = makeResult(40);
    const area = analyseDamage(result, 0.04); // 200 m square ≈ 20 cells across
    const half = boundaryHalfWidthM(0.04);
    const cx = result.grid.x0 + ((NX - 1) / 2) * DX;
    for (let r = 0; r < NY; r++) {
      for (let c = 0; c < NX; c++) {
        const x = result.grid.x0 + c * DX;
        const y = result.grid.y0 + r * DX;
        const outside = Math.abs(x - cx) > half + DX || Math.abs(y - cx) > half + DX;
        if (outside) expect(area.damageClass[r * NX + c]).toBe(0);
      }
    }
  });
});

describe("damage bands", () => {
  it("bands are ordered low → high and cover only wet cells", () => {
    const result = makeResult(20);
    const d = analyseDamage(result, 1);
    expect(d.bands.map((b) => b.id)).toEqual(["low", "medium", "high"]);
    const total = d.bands.reduce((n, b) => n + b.cellCount, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(NX * NY);
  });

  it("deeper cells never get a lower class than shallower ones sharing a velocity", () => {
    const result = makeResult(20);
    const centre = (NY / 2) * NX + NX / 2;
    const rim = (NY / 2) * NX + NX / 2 + 18;
    const d = analyseDamage(result, 1);
    expect(d.damageClass[centre]).toBeGreaterThanOrEqual(d.damageClass[rim]);
    expect(d.damageClass[centre]).toBe(3);
  });

  it("falls back to depth-only when nothing is moving", () => {
    const still = analyseDamage(makeResult(20, 0), 1);
    expect(still.method).toBe("depth_only");
    const moving = analyseDamage(makeResult(20, 1.5), 1);
    expect(moving.method).toBe("hazard_depth");
  });

  it("honours the 1.5 m depth override even at negligible velocity", () => {
    const result = makeResult(20, 0);
    result.maxDepth[(NY / 2) * NX + NX / 2] = DEFAULT_THRESHOLDS.highDepthOverrideM + 0.2;
    const d = analyseDamage(result, 1);
    expect(d.damageClass[(NY / 2) * NX + NX / 2]).toBe(3);
  });
});

describe("flow direction field", () => {
  it("reports east for a uniform eastward slope in depth", () => {
    const result = makeResult(0, 0);
    // Water deep on the west, shallow on the east → flow travels east.
    for (let r = 40; r < 80; r++) {
      for (let c = 30; c < 90; c++) {
        const i = r * NX + c;
        result.maxDepth[i] = 1.0 - (c - 30) / 90;
        result.maxVelocity[i] = 1.0;
      }
    }
    const flow = analyseFlow(result, 1);
    expect(flow.meanDirDeg).toBeGreaterThan(60);
    expect(flow.meanDirDeg).toBeLessThan(120);
    expect(flow.dominantLabel).toBe("E");
  });

  it("vector count is bounded regardless of domain size", () => {
    const flow = analyseFlow(makeResult(50, 1), 1);
    expect(flow.vectors.length).toBeLessThanOrEqual(240);
    for (const v of flow.vectors) {
      expect(Number.isFinite(v.lng)).toBe(true);
      expect(Number.isFinite(v.lat)).toBe(true);
      expect(v.dirDeg).toBeGreaterThanOrEqual(0);
      expect(v.dirDeg).toBeLessThan(360);
    }
  });

  it("an empty result reports no vectors instead of throwing", () => {
    const flow = analyseFlow(makeResult(0, 0), 1);
    expect(flow.vectors.length).toBe(0);
    expect(flow.boundaryWetFraction).toBe(0);
  });

  it("produces fluent multi-directional streamlines radiating from the leak", () => {
    const result = makeResult(0, 0);
    const midR = NY / 2;
    const midC = NX / 2;
    result.flowX = new Float32Array(NX * NY);
    result.flowY = new Float32Array(NX * NY);

    // Simulate water flowing downhill to South (rows 0 to midR)
    for (let r = 0; r <= midR; r++) {
      for (let c = midC - 10; c <= midC + 10; c++) {
        const i = r * NX + c;
        result.maxDepth[i] = 0.8;
        result.maxVelocity[i] = 1.2;
        result.flowY[i] = -1.2 * 0.8;
      }
    }
    // Also simulate a secondary branch to East (cols midC to NX-1)
    for (let r = midR - 5; r <= midR + 5; r++) {
      for (let c = midC; c < NX; c++) {
        const i = r * NX + c;
        result.maxDepth[i] = 0.5;
        result.maxVelocity[i] = 0.8;
        result.flowX[i] = 0.8 * 0.5;
      }
    }

    const flow = analyseFlow(result, 1);
    expect(flow.streamlines).toBeDefined();
    expect(flow.streamlines!.length).toBeGreaterThan(1);

    // Verify streamline widths are elegant and fluid (e.g. 2m - 12m, not 55m)
    for (const s of flow.streamlines!) {
      expect(s.widthM).toBeGreaterThanOrEqual(2);
      expect(s.widthM).toBeLessThanOrEqual(15);
      expect(s.path.length).toBeGreaterThanOrEqual(3);
      expect(s.arrowHead.length).toBeGreaterThanOrEqual(3);
    }

    // Verify presence of primary and branch roles
    expect(flow.streamlines!.some((s) => s.role === "primary")).toBe(true);
    expect(flow.primaryArrow).toBeDefined();
    expect(flow.primaryArrow!.widthM).toBeLessThanOrEqual(15);
  });

  it("generates streamlines for multiple distinct outflow corridors (NW, SE, SW)", () => {
    const result = makeResult(35, 1.2);
    const n = NX * NY;
    result.flowX = new Float32Array(n);
    result.flowY = new Float32Array(n);
    const cx = (NX - 1) / 2;
    const cy = (NY - 1) / 2;

    // Simulate flow in NW, SE, and SW corridors
    for (let r = 0; r < NY; r++) {
      for (let c = 0; c < NX; c++) {
        const i = r * NX + c;
        const dxFromTank = c - cx;
        const dyFromTank = r - cy;
        const dist = Math.hypot(dxFromTank, dyFromTank);
        if (dist > 3 && dist < 32) {
          // NW corridor: negative X, positive Y
          if (dxFromTank < -2 && dyFromTank > 2) {
            result.maxDepth[i] = 0.8;
            result.maxVelocity[i] = 1.5;
            result.flowX[i] = -1.0;
            result.flowY[i] = 1.0;
          }
          // SE corridor: positive X, negative Y
          if (dxFromTank > 2 && dyFromTank < -2) {
            result.maxDepth[i] = 0.6;
            result.maxVelocity[i] = 1.2;
            result.flowX[i] = 1.0;
            result.flowY[i] = -1.0;
          }
          // SW corridor: negative X, negative Y
          if (dxFromTank < -2 && dyFromTank < -2) {
            result.maxDepth[i] = 0.5;
            result.maxVelocity[i] = 1.1;
            result.flowX[i] = -1.0;
            result.flowY[i] = -1.0;
          }
        }
      }
    }

    const flow = analyseFlow(result, 1);
    expect(flow.streamlines).toBeDefined();
    expect(flow.streamlines!.length).toBeGreaterThanOrEqual(3);

    // Verify bearings cover multiple sectors (NW, SE, SW)
    const bearings = flow.streamlines!.map((s) => s.headBearingDeg);
    const hasNW = bearings.some((b) => b >= 270 && b <= 355);
    const hasSE = bearings.some((b) => b >= 95 && b <= 175);
    const hasSW = bearings.some((b) => b >= 185 && b <= 265);
    expect(hasNW).toBe(true);
    expect(hasSE).toBe(true);
    expect(hasSW).toBe(true);
  });
});

// ---------------------------------------------------------------- shapefile round-trip

interface Parsed {
  fileCode: number;
  shapeType: number;
  bbox: number[];
  records: { number: number; shapeType: number; parts: number[][][] }[];
}

function parseShp(bytes: Uint8Array): Parsed {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileCode = v.getInt32(0, false);
  const declaredBytes = v.getInt32(24, false) * 2;
  expect(declaredBytes).toBe(bytes.byteLength); // header length field must match reality
  const shapeType = v.getInt32(32, true);
  const bbox = [v.getFloat64(36, true), v.getFloat64(44, true), v.getFloat64(52, true), v.getFloat64(60, true)];
  const records: Parsed["records"] = [];
  let p = 100;
  while (p < bytes.byteLength) {
    const number = v.getInt32(p, false);
    const contentWords = v.getInt32(p + 4, false);
    const contentStart = p + 8;
    const st = v.getInt32(contentStart, true);
    let parts: number[][][] = [];
    if (st === 3 || st === 5) {
      const numParts = v.getInt32(contentStart + 36, true);
      const numPoints = v.getInt32(contentStart + 40, true);
      const offsets: number[] = [];
      for (let i = 0; i < numParts; i++) offsets.push(v.getInt32(contentStart + 44 + i * 4, true));
      const ptsStart = contentStart + 44 + numParts * 4;
      const all: number[][] = [];
      for (let i = 0; i < numPoints; i++) {
        all.push([v.getFloat64(ptsStart + i * 16, true), v.getFloat64(ptsStart + i * 16 + 8, true)]);
      }
      parts = offsets.map((o, i) => all.slice(o, offsets[i + 1] ?? all.length));
    }
    records.push({ number, shapeType: st, parts });
    p = contentStart + contentWords * 2;
  }
  return { fileCode, shapeType, bbox, records };
}

describe("shapefile writer", () => {
  const records = [
    { parts: [[[39.6, 24.46], [39.61, 24.46], [39.61, 24.47], [39.6, 24.47], [39.6, 24.46]]], attributes: { NAME: "low", AREA: 12345.6 } },
    { parts: [[[39.62, 24.48], [39.63, 24.48], [39.63, 24.49], [39.62, 24.49], [39.62, 24.48]]], attributes: { NAME: "high", AREA: 99 } },
  ];

  it("writes a polygon .shp that parses back to the same rings", () => {
    const shp = buildShp("polygon", records);
    const parsed = parseShp(shp);
    expect(parsed.fileCode).toBe(9994);
    expect(parsed.shapeType).toBe(5);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].parts[0][0]).toEqual([39.6, 24.46]);
    expect(parsed.records[1].parts[0]).toHaveLength(5);
    expect(parsed.bbox[0]).toBeCloseTo(39.6, 9);
    expect(parsed.bbox[3]).toBeCloseTo(24.49, 9);
  });

  it("writes a polyline .shp with shape type 3", () => {
    const lines = [{ parts: [[[39.6, 24.46], [39.6005, 24.4605]]], attributes: {} }];
    const parsed = parseShp(buildShp("polyline", lines));
    expect(parsed.shapeType).toBe(3);
    expect(parsed.records[0].parts[0]).toHaveLength(2);
  });

  it("writes an .shx index whose offsets point at real records", () => {
    const shp = buildShp("polygon", records);
    const shx = buildShx("polygon", records);
    const v = new DataView(shx.buffer, shx.byteOffset, shx.byteLength);
    expect(v.getInt32(0, false)).toBe(9994);
    expect(v.getInt32(24, false) * 2).toBe(shx.byteLength);
    // first index entry
    const offsetWords = v.getInt32(100, false);
    const contentWords = v.getInt32(104, false);
    const recordStart = offsetWords * 2;
    // record number at the indexed offset must be 1
    const shpView = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
    expect(shpView.getInt32(recordStart, false)).toBe(1);
    expect(recordStart + 8 + contentWords * 2).toBeLessThanOrEqual(shp.byteLength);
  });

  it("writes a .dbf with correct header counts and padded fields", () => {
    const fields = [
      { name: "NAME", type: "C" as const, length: 8 },
      { name: "AREA", type: "N" as const, length: 10, decimals: 1 },
    ];
    const dbf = buildDbf(fields, records.map((r) => r.attributes as Record<string, string | number>));
    const v = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
    expect(v.getUint8(0)).toBe(0x03);
    expect(v.getUint32(4, true)).toBe(2); // record count
    const headerLen = v.getUint16(8, true);
    const recordLen = v.getUint16(10, true);
    expect(headerLen).toBe(32 + fields.length * 32 + 1);
    expect(recordLen).toBe(1 + 8 + 10);
    expect(dbf[headerLen - 1]).toBe(0x0d);
    const text = new TextDecoder().decode(dbf.subarray(headerLen, headerLen + recordLen));
    expect(text.startsWith(" ")).toBe(true);
    expect(text).toContain("low");
    expect(text).toContain("12345.6");
    expect(dbf[dbf.length - 1]).toBe(0x1a);
  });
});
