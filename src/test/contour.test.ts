import { describe, expect, it } from "vitest";
import { damageContours, contourAreas, waterExtentRings, arrivalIsochrones } from "../analysis/contours";
import { analyseDamage } from "../analysis/impact";
import { makeLocalCRS } from "../engine/geo";
import type { SimulationResult } from "../engine/types";

const NX = 100, NY = 100, DX = 10;
const crs = makeLocalCRS(39.6111, 24.4672);

function makeResult(): SimulationResult {
  const n = NX * NY, maxDepth = new Float32Array(n), maxVelocity = new Float32Array(n);
  const cx = NX / 2, cy = NY / 2;
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
    const d = Math.hypot(c - cx, r - cy);
    if (d < 26) {
      const i = r * NX + c;
      // A real gradient: deep and fast in the middle, thin and slow at the rim, so all three
      // bands exist and the score field is smooth.
      maxDepth[i] = 1.2 * (1 - d / 26) + 0.02;
      maxVelocity[i] = 0.9 * (1 - d / 26) + 0.05;
    }
  }
  return {
    tankGroundElevationM: null,
    hydro: { points: [], peakQ: 0, peakQTimeS: 0, totalVolumeM3: 0, emptyTimeS: 0, stopReason: "empty", residualVolumeM3: 0, method: "orifice" },
    maxDepth, arrivalTime: new Float32Array(n).fill(1), maxVelocity, wetDuration: new Float32Array(n),
    frames: [], frameTimes: [], frameStats: [],
    depthClass: new Uint8Array(n), hazardClass: new Uint8Array(n),
    mass: { releasedM3: 0, wetM3: 0, infiltrationM3: 0, outflowM3: 0, tankResidualM3: 0, errorM3: 0, clampedM3: 0, errorPercent: 0, ok: true },
    classes: [],
    stats: { affectedAreaM2: 0, maxDepthM: 0, meanDepthAffectedM: 0, maxVelocityMs: 0, maxExtentDistanceM: 0, firstArrivalS: 0, peakDepthTimeS: 0, wetCellCount: 0 },
    damageClass: new Uint8Array(n), damageScore: new Uint8Array(n), damageBands: [], damageMethod: "hazard_depth",
    flow: { vectors: [], meanDirDeg: 0, concentration: 0, dominantDirDeg: 0, dominantLabel: "N", speedP95Ms: 0, boundaryAreaM2: 0, boundaryWetAreaM2: 0, boundaryWetFraction: 0 },
    grid: { nx: NX, ny: NY, dx: DX, x0: -(NX / 2) * DX, y0: -(NY / 2) * DX, z: new Float32Array(n), crs } as SimulationResult["grid"],
    options: { reportingDepthM: 0.005 } as SimulationResult["options"],
    computeMs: 0, hash: "t", warnings: [],
  };
}

describe("heat-map contours", () => {
  it("produces smooth closed rings, not per-cell rectangles", () => {
    const r = makeResult();
    const d = analyseDamage(r, 1);
    r.damageScore = d.damageScore;
    r.damageClass = d.damageClass;
    const bands = damageContours(r);
    expect(bands.length).toBeGreaterThan(0);
    // A disc must not need dozens of polygons.
    const total = bands.reduce((n, b) => n + b.polygons.length, 0);
    expect(total).toBeLessThan(10);
    for (const b of bands) for (const poly of b.polygons) {
      const ring = poly[0];
      expect(ring.length).toBeGreaterThan(8);          // smooth, not a 4-vertex box
      expect(ring[0]).toEqual(ring[ring.length - 1]);  // closed
      for (const [lng, lat] of ring) {
        expect(lng).toBeGreaterThan(39.5);
        expect(lng).toBeLessThan(39.7);
        expect(lat).toBeGreaterThan(24.4);
        expect(lat).toBeLessThan(24.55);
      }
    }
  });

  it("contoured areas track the classified cell areas", () => {
    const r = makeResult();
    const d = analyseDamage(r, 1);
    r.damageScore = d.damageScore;
    r.damageClass = d.damageClass;
    const areas = contourAreas(damageContours(r));
    expect(areas.high).toBeGreaterThan(0);
    expect(areas.medium).toBeGreaterThan(0);
    expect(areas.low).toBeGreaterThan(0);
    // Nested bands: high ⊆ medium ⊆ low, so the areas must strictly increase.
    expect(areas.high).toBeLessThan(areas.medium);
    expect(areas.medium).toBeLessThan(areas.low);
    // And the outermost contour must be within ~25 % of the wet-cell footprint.
    const wetCells = r.maxDepth.filter((x) => x >= 0.005).length * DX * DX;
    expect(Math.abs(areas.low - wetCells) / wetCells).toBeLessThan(0.25);
  });

  it("waterExtentRings produces merged contiguous shoreline centered at the tank without isolated fragments", () => {
    const r = makeResult();
    const rings = waterExtentRings(r);
    expect(rings.length).toBeGreaterThan(0);
    // Must be merged into a small number of continuous outer rings, not fragmented into dozens of puddles
    expect(rings.length).toBeLessThan(5);
    const mainRing = rings[0];
    expect(mainRing.length).toBeGreaterThan(12);
    // Closed loop
    expect(mainRing[0]).toEqual(mainRing[mainRing.length - 1]);
  });

  it("arrivalIsochrones generates progressive wavefront contours (Option D)", () => {
    const r = makeResult();
    const cx = NX / 2, cy = NY / 2;
    for (let row = 0; row < NY; row++) {
      for (let c = 0; c < NX; c++) {
        const d = Math.hypot(c - cx, row - cy);
        const i = row * NX + c;
        if (d < 26) {
          r.arrivalTime[i] = d * 60; // 0 to 1560 seconds (up to 26 min)
        } else {
          r.arrivalTime[i] = -1;
        }
      }
    }
    const isos = arrivalIsochrones(r);
    expect(isos.length).toBeGreaterThan(1);
    for (const iso of isos) {
      expect(iso.lines.length).toBeGreaterThan(0);
      expect(iso.label).toContain("T +");
      expect(iso.colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
