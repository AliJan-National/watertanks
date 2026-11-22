import { describe, expect, it } from "vitest";
import {
  analyticEmptyingTimeS,
  computeHydrograph,
  holeArea,
  tankGeometry,
} from "../engine/hydrograph";
import { simulateShallowFlow } from "../engine/shallowFlow";
import { buildGrid } from "../engine/grid";
import type { Grid, ScenarioSpec, SimulationOptions, TankSpec } from "../engine/types";

const OPTS: SimulationOptions = {
  manningN: 0.05,
  infiltrationMmPerHr: 0,
  reportingDepthM: 0.001,
  maxDurationS: 24 * 3600,
  frameCount: 24,
  maxCells: 500_000,
  buildingsAsObstacles: false,
  smoothDem: false,
};

const TANK: TankSpec = {
  id: "t1",
  name: "Test tank",
  shape: "cylindrical",
  capacityM3: 1000,
  diameterM: 12,
  wallHeightM: 10,
  waterHeadM: 10,
  baseElevationM: 100,
  location: { lng: 39.61, lat: 24.47 },
  fluid: "water",
};

/** Builds a synthetic metric grid directly (row 0 = south, x increases east). */
function makeGrid(nx: number, dx: number, zfn: (x: number, y: number) => number): Grid {
  const x0 = -((nx - 1) / 2) * dx;
  const z = new Float32Array(nx * nx);
  for (let r = 0; r < nx; r++) {
    for (let c = 0; c < nx; c++) z[r * nx + c] = zfn(x0 + c * dx, x0 + r * dx);
  }
  return {
    nx,
    ny: nx,
    x0,
    y0: x0,
    dx,
    z,
    crs: { lon0: 39.61, lat0: 24.47, unitScale: 1, proj4: "" },
  };
}

function run(grid: Grid, tank: TankSpec, scenario: ScenarioSpec, opts: Partial<SimulationOptions> = {}) {
  const geom = tankGeometry(tank);
  const hydro = computeHydrograph(tank, scenario, geom);
  const res = simulateShallowFlow({
    grid,
    tank,
    scenario,
    hydro,
    options: { ...OPTS, ...opts, maxCells: grid.nx * grid.ny },
  });
  return { res, hydro };
}

const catastrophic: ScenarioSpec = {
  mode: "catastrophic_breach",
  holeShape: "circular",
  holeElevationAboveBaseM: 0,
  dischargeCoefficientCd: 0.61,
  breachWidthM: 8,
};

const leak100: ScenarioSpec = {
  mode: "leak",
  holeShape: "circular",
  holeDiameterM: 0.1,
  holeElevationAboveBaseM: 0,
  dischargeCoefficientCd: 0.61,
};

// ---------------------------------------------------------------- release model
describe("Stage A — tank release hydrograph", () => {
  it("reproduces the analytic Torricelli emptying time within 10 % for a bottom hole", () => {
    const geom = tankGeometry(TANK);
    const hydro = computeHydrograph(TANK, leak100, geom);
    const analytic = analyticEmptyingTimeS((Math.PI * 12 * 12) / 4, holeArea(0.1), 0.61, 10);
    expect(Math.abs(hydro.emptyTimeS - analytic) / analytic).toBeLessThan(0.1);
  });

  it("never releases more water than the tank holds", () => {
    const geom = tankGeometry(TANK);
    for (const d of [0.01, 0.05, 0.1, 0.25, 1.0]) {
      const h = computeHydrograph(TANK, { ...leak100, holeDiameterM: d }, geom);
      expect(h.totalVolumeM3).toBeLessThanOrEqual(geom.geometricCapacityM3 + 1e-6);
      expect(h.peakQ).toBeGreaterThan(0);
    }
  });

  it("gives a larger peak discharge for a larger opening", () => {
    const geom = tankGeometry(TANK);
    const peak = (d: number) =>
      computeHydrograph(TANK, { ...leak100, holeDiameterM: d }, geom).peakQ;
    expect(peak(0.1)).toBeGreaterThan(peak(0.05));
    expect(peak(0.05)).toBeGreaterThan(peak(0.01));
  });

  it("honours a user-specified release duration", () => {
    const geom = tankGeometry(TANK);
    const h = computeHydrograph(TANK, { ...catastrophic, durationSeconds: 120 }, geom);
    expect(h.emptyTimeS).toBeLessThanOrEqual(120.5);
    expect(h.stopReason).toBe("duration");
  });

  it("produces a valid tank volume-depth curve for every supported shape", () => {
    for (const shape of ["cylindrical", "rectangular", "horizontal_cylindrical", "spherical_partial"] as const) {
      const geom = tankGeometry({ ...TANK, shape });
      expect(geom.geometricCapacityM3).toBeGreaterThan(0);
      expect(geom.volumeAtHead(0)).toBeCloseTo(0, 6);
      // Monotonic in head
      let prev = -1;
      for (let h = 0; h <= TANK.wallHeightM; h += 0.5) {
        const v = geom.volumeAtHead(h);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });
});

// ---------------------------------------------------------------- routing engine
describe("Stage B — 2-D shallow-flow routing", () => {
  it("conserves water on a flat plane (released = stored + outflow)", () => {
    const grid = makeGrid(161, 10, () => 100);
    const { res } = run(grid, TANK, catastrophic);
    expect(Math.abs(res.mass.errorPercent)).toBeLessThan(1);
    expect(res.mass.releasedM3).toBeGreaterThan(1000);
    // On a flat plane with an open boundary, most water either ponds or leaves the domain.
    expect(res.mass.wetM3 + res.mass.outflowM3).toBeCloseTo(res.mass.releasedM3, -1);
  });

  it("conserves water on a 2 % slope and reports the outflow explicitly", () => {
    const grid = makeGrid(161, 10, (x) => 100 - 0.02 * x);
    const { res } = run(grid, TANK, catastrophic);
    expect(Math.abs(res.mass.errorPercent)).toBeLessThan(1);
    expect(res.mass.outflowM3).toBeGreaterThan(0);
  });

  it("routes water downhill, not uphill", () => {
    // Ground falls to the east (+x), so the wet centroid must end up east of the tank.
    const grid = makeGrid(161, 10, (x) => 100 - 0.02 * x);
    // A 2 % slope spreads 1 131 m3 over a very thin sheet, so the wet-cell detection needs a
    // threshold well under the mean film depth (~0.4 mm over this domain).
    // A 2 % slope spreads 1 131 m3 into a sheet only a few millimetres deep, so the wet
    // footprint is best read from the arrival raster (water did reach the cell) rather than
    // from a depth threshold that would only catch the deepest few cells.
    const { res } = run(grid, TANK, catastrophic, { reportingDepthM: 0.00002 });
    let sx = 0;
    let w = 0;
    for (let i = 0; i < res.arrivalTime.length; i++) {
      if (!(res.arrivalTime[i] >= 0)) continue;
      const c = i % grid.nx;
      sx += grid.x0 + c * grid.dx;
      w++;
    }
    expect(w).toBeGreaterThan(10);
    expect(sx / w).toBeGreaterThan(10);
  });

  it("accumulates water in a closed depression (a bowl)", () => {
    // Bowl of radius 150 m centred on the tank, with a raised rim so water cannot escape.
    const grid = makeGrid(161, 10, (x, y) => {
      const r = Math.hypot(x, y);
      if (r < 150) return 100 - (150 - r) * 0.1; // bowl floor, up to 15 m deep at centre
      return 100 + Math.min(6, (r - 150) * 0.05); // rim rising to +6 m
    });
    const tank = { ...TANK, baseElevationM: 99.9 };
    const { res } = run(grid, tank, catastrophic, { maxDurationS: 6 * 3600 });
    expect(Math.abs(res.mass.errorPercent)).toBeLessThan(1);
    // Water must be retained in the bowl, not vanish over the rim.
    expect(res.mass.wetM3).toBeGreaterThan(res.mass.releasedM3 * 0.3);
    expect(res.stats.maxDepthM).toBeGreaterThan(0.2);
  });

  it("reports a larger volume and wet area for a fuller tank", () => {
    const grid = makeGrid(161, 10, (x) => 100 - 0.01 * x);
    // Same tank, two different initial fill levels.
    const quarter = run(grid, { ...TANK, waterHeadM: 2.5 }, catastrophic, { reportingDepthM: 0.00002 });
    const full = run(grid, { ...TANK, waterHeadM: 10 }, catastrophic, { reportingDepthM: 0.00002 });
    // A fuller tank releases far more water, and that water has to go somewhere: more is
    // stored in the domain and more leaves through the open boundary.
    expect(full.res.mass.releasedM3).toBeGreaterThan(quarter.res.mass.releasedM3 * 3);
    expect(full.res.mass.wetM3).toBeGreaterThan(quarter.res.mass.wetM3);
    expect(full.res.mass.outflowM3 + full.res.mass.wetM3).toBeGreaterThan(
      quarter.res.mass.outflowM3 + quarter.res.mass.wetM3,
    );
    // Both runs must still close their mass balance.
    expect(Math.abs(quarter.res.mass.errorPercent)).toBeLessThan(1);
    expect(Math.abs(full.res.mass.errorPercent)).toBeLessThan(1);
  });

  it("is deterministic for identical inputs", () => {
    const grid = makeGrid(101, 10, (x, y) => 100 - 0.01 * Math.hypot(x, y));
    const a = run(grid, TANK, catastrophic);
    const b = run(grid, TANK, catastrophic);
    expect(a.res.hash).toBe(b.res.hash);
    expect(a.res.stats.affectedAreaM2).toBeCloseTo(b.res.stats.affectedAreaM2, 6);
  });

  it("records arrival times that increase with distance downstream", () => {
    const grid = makeGrid(161, 10, (x) => 100 - 0.02 * x);
    const { res } = run(grid, TANK, catastrophic, { reportingDepthM: 0.001 });
    const rMid = Math.floor(grid.ny / 2);
    const cTank = Math.floor(grid.nx / 2);
    const near = res.arrivalTime[rMid * grid.nx + cTank + 2];
    const far = res.arrivalTime[rMid * grid.nx + cTank + 12];
    expect(near).toBeGreaterThanOrEqual(0);
    if (far >= 0) expect(far).toBeGreaterThanOrEqual(near);
  });

  it("classifies every wet cell into exactly one depth class that sums to the affected area", () => {
    const grid = makeGrid(161, 10, (x) => 100 - 0.01 * x);
    const { res } = run(grid, TANK, catastrophic, { reportingDepthM: 0.001 });
    const sum = res.classes.reduce((a, c) => a + c.areaM2, 0);
    expect(sum).toBeCloseTo(res.stats.affectedAreaM2, 3);
    expect(res.classes.reduce((a, c) => a + c.cellCount, 0)).toBe(res.stats.wetCellCount);
  });

  it("applies infiltration as a real loss, not a silent deletion", () => {
    const grid = makeGrid(121, 10, () => 100);
    const dry = run(grid, TANK, catastrophic, { infiltrationMmPerHr: 0 });
    const wet = run(grid, TANK, catastrophic, { infiltrationMmPerHr: 50 });
    expect(wet.res.mass.infiltrationM3).toBeGreaterThan(0);
    expect(Math.abs(wet.res.mass.errorPercent)).toBeLessThan(1);
    expect(wet.res.mass.wetM3).toBeLessThan(dry.res.mass.wetM3);
  });

  it("warns instead of silently losing water when the domain is too small", () => {
    const grid = makeGrid(31, 10, (x) => 100 - 0.4 * x);
    const { res } = run(grid, TANK, catastrophic);
    expect(res.mass.outflowM3).toBeGreaterThan(0);
    expect(res.warnings.some((w) => w.includes("left the analysis domain"))).toBe(true);
    expect(Math.abs(res.mass.errorPercent)).toBeLessThan(1);
  });

  it("keeps frames consistent: no water before its arrival time", () => {
    const grid = makeGrid(121, 10, (x) => 100 - 0.02 * x);
    const { res } = run(grid, TANK, catastrophic, { reportingDepthM: 0.002 });
    for (let f = 0; f < res.frames.length; f++) {
      const frame = res.frames[f];
      const t = res.frameTimes[f];
      for (let i = 0; i < frame.length; i++) {
        if (frame[i] > 0) {
          expect(res.arrivalTime[i]).toBeLessThanOrEqual(t + 1e-6);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- grid builder
describe("analysis grid construction", () => {
  const mkDem = (n: number, sizeM: number, zfn: (eastM: number, northM: number) => number) => {
    const half = sizeM / 2;
    const mLon = 101_000;
    const mLat = 110_900;
    const data = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const east = (-half) + ((c + 0.5) / n) * sizeM;
        const north = half - ((r + 0.5) / n) * sizeM;
        data[r * n + c] = zfn(east, north);
      }
    }
    return {
      data,
      nx: n,
      ny: n,
      minLon: 39.61 - half / mLon,
      maxLon: 39.61 + half / mLon,
      minLat: 24.47 - half / mLat,
      maxLat: 24.47 + half / mLat,
      metadata: {
        source: "user_upload" as const,
        label: "synthetic",
        resolutionM: sizeM / n,
        verticalAccuracyM: 0,
        surfaceModel: false,
        attribution: "test",
        licence: "test",
        gridCellSizeM: sizeM / n,
        nodataFraction: 0,
        minZM: 0,
        maxZM: 0,
      },
    };
  };

  it("coarsens the cell size to respect the cell budget", () => {
    const dem = mkDem(240, 10_000, () => 100);
    const built = buildGrid(dem, {
      centreLon: 39.61,
      centreLat: 24.47,
      targetCellSizeM: 5,
      radiusM: 5000,
      maxCells: 60_000,
      smooth: false,
    });
    expect(built.coarsened).toBe(true);
    expect(built.grid.nx * built.grid.ny).toBeLessThanOrEqual(60_000 * 1.2);
    expect(built.grid.dx).toBeGreaterThan(5);
  });

  it("preserves an east-west plane within ~1 m over a 4 km domain", () => {
    const dem = mkDem(200, 8000, (east) => 100 + 0.01 * east);
    const built = buildGrid(dem, {
      centreLon: 39.61,
      centreLat: 24.47,
      targetCellSizeM: 20,
      radiusM: 2000,
      maxCells: 400_000,
      smooth: false,
    });
    const { nx, ny, z } = built.grid;
    const mid = Math.floor(ny / 2);
    const west = z[mid * nx + 1];
    const east = z[mid * nx + nx - 2];
    const spanM = (nx - 3) * built.grid.dx;
    expect(Math.abs(east - west - 0.01 * spanM)).toBeLessThan(1.0);
  });
});

describe("regression: water received by a previously dry cell", () => {
  /**
   * A donor that pushes water onto dry ground must have that water integrated in the SAME
   * step. Before the fix the dry cell's incoming faces were skipped, the volume vanished, and
   * the run reported a mass-balance error of up to ~19 % while also under-predicting spread.
   */
  it("keeps the balance closed while the front advances over dry ground", () => {
    const dem = { nx: 120, ny: 120 };
    const data = new Float32Array(dem.nx * dem.ny).fill(600);
    const grid = buildGrid(
      {
        data,
        nx: dem.nx,
        ny: dem.ny,
        minLon: 39.5,
        minLat: 24.4,
        maxLon: 39.72,
        maxLat: 24.58,
        metadata: { source: "test", label: "test" } as never,
      },
      { centreLon: 39.61, centreLat: 24.47, targetCellSizeM: 12, radiusM: 600, maxCells: 200_000, smooth: false },
    ).grid;

    const tank: TankSpec = {
      id: "t",
      name: "t",
      shape: "cylindrical",
      capacityM3: 250,
      diameterM: 10,
      wallHeightM: 3,
      waterHeadM: 3,
      fluid: "water",
      location: { lng: 39.61, lat: 24.47 },
      baseElevationM: 600,
    };
    const scenario: ScenarioSpec = {
      mode: "catastrophic_breach",
      holeShape: "circular",
      holeDiameterM: 0.1,
      holeElevationAboveBaseM: 0,
      dischargeCoefficientCd: 0.61,
      breachWidthM: 6,
      breachDevelopmentSeconds: 0,
    };
    const res = simulateShallowFlow({
      grid,
      tank,
      scenario,
      hydro: computeHydrograph(tank, scenario, tankGeometry(tank)),
      // A short cap keeps this a unit test rather than a 3-minute soak: the wetting front
      // crosses several dry cells within the first minutes of a 250 m³ release.
      options: { ...OPTS, cellSizeM: 12, maxCells: 200_000, maxDurationS: 900 },
    });
    const msg = `err=${res.mass.errorPercent.toFixed(3)}% clamped=${res.mass.clampedM3.toFixed(2)} extent=${res.stats.maxExtentDistanceM.toFixed(1)} steps=${res.warnings.length}`;
    expect(Math.abs(res.mass.errorPercent), msg).toBeLessThan(1);
    // The front must actually have left the tank footprint.
    expect(res.stats.maxExtentDistanceM, msg).toBeGreaterThan(10);
  });
});
