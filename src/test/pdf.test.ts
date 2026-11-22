import { describe, expect, it } from "vitest";
import { buildPdf } from "../export/pdf";
import type { SimulationResult, TankSpec, ScenarioSpec } from "../engine/types";

describe("PDF export", () => {
  it("builds a valid PDF blob without throwing", async () => {
    const tank: TankSpec = {
      id: "t1",
      name: "Al-Aziziyah Storage Tank A",
      shape: "cylindrical",
      capacityM3: 5000,
      diameterM: 25,
      wallHeightM: 10.5,
      waterHeadM: 10.2,
      baseElevationM: 612.4,
      location: { lng: 39.6111, lat: 24.4672 },
      fluid: "water",
    };
    const scenario: ScenarioSpec = {
      mode: "catastrophic_breach",
      breachWidthM: 8,
      dischargeCoefficientCd: 0.61,
      holeShape: "circular",
      holeElevationAboveBaseM: 0,
    };
    const result: SimulationResult = {
      tankGroundElevationM: 612.4,
      hydro: {
        points: [
          { t: 0, q: 0, vRemaining: 5000, vReleased: 0, head: 10 },
          { t: 60, q: 85, vRemaining: 2000, vReleased: 3000, head: 4 },
          { t: 180, q: 0, vRemaining: 0, vReleased: 5000, head: 0 },
        ],
        peakQ: 85.2,
        peakQTimeS: 60,
        totalVolumeM3: 5000,
        emptyTimeS: 180,
        stopReason: "empty",
        residualVolumeM3: 0,
        method: "weir",
      },
      maxDepth: new Float32Array(100).fill(0.5),
      arrivalTime: new Float32Array(100).fill(12),
      maxVelocity: new Float32Array(100).fill(1.8),
      wetDuration: new Float32Array(100).fill(180),
      frames: [],
      frameTimes: [0, 60, 180],
      frameStats: [],
      depthClass: new Uint8Array(100),
      hazardClass: new Uint8Array(100),
      mass: {
        releasedM3: 5000,
        wetM3: 4950,
        infiltrationM3: 40,
        outflowM3: 10,
        tankResidualM3: 0,
        errorM3: 0,
        clampedM3: 0,
        errorPercent: 0.05,
        ok: true,
      },
      classes: [
        { id: "1", label: "< 0.15 m", minM: 0.005, maxM: 0.15, cellCount: 40, areaM2: 4000, colour: "#ffff00" },
        { id: "2", label: "0.15–0.5 m", minM: 0.15, maxM: 0.5, cellCount: 30, areaM2: 3000, colour: "#ffa500" },
        { id: "3", label: "> 0.5 m", minM: 0.5, maxM: 2.0, cellCount: 30, areaM2: 3000, colour: "#ff0000" },
      ],
      stats: {
        affectedAreaM2: 10000,
        maxDepthM: 1.8,
        meanDepthAffectedM: 0.495,
        maxVelocityMs: 3.2,
        maxExtentDistanceM: 450,
        firstArrivalS: 5,
        peakDepthTimeS: 65,
        wetCellCount: 100,
      },
      damageClass: new Uint8Array(100),
      damageScore: new Uint8Array(100),
      damageBands: [],
      damageMethod: "hazard_depth",
      flow: {
        vectors: [],
        meanDirDeg: 135,
        concentration: 0.8,
        dominantDirDeg: 135,
        dominantLabel: "SE",
        speedP95Ms: 2.1,
        boundaryAreaM2: 1000000,
        boundaryWetAreaM2: 10000,
        boundaryWetFraction: 0.01,
      },
      grid: {
        nx: 10,
        ny: 10,
        dx: 10,
        x0: 0,
        y0: 0,
        z: new Float32Array(100),
        crs: { lon0: 39.6111, lat0: 24.4672, unitScale: 1, proj4: "" },
      },
      options: { reportingDepthM: 0.005 } as any,
      computeMs: 120,
      hash: "abc1234",
      warnings: [],
    };

    // 1x1 white jpeg
    const dummyJpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

    const blob = await buildPdf({
      tank,
      scenario,
      result,
      exposure: null,
      dem: null,
      mapImage: dummyJpeg,
      attribution: "Test Attribution",
      runHash: "abc1234",
      appVersion: "1.0.0",
      scenarioLabel: "Breach 8 m",
    });

    expect(blob).toBeDefined();
    expect(blob.size).toBeGreaterThan(1000);
  });
});
