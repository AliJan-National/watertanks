import { it, expect } from "vitest";
import { computeHydrograph, tankGeometry } from "../engine/hydrograph";
import { simulateShallowFlow } from "../engine/shallowFlow";
import type { Grid, ScenarioSpec, TankSpec, SimulationOptions } from "../engine/types";

const OPTS: SimulationOptions = { manningN: 0.05, infiltrationMmPerHr: 0, reportingDepthM: 0.005, maxDurationS: 900, frameCount: 24, maxCells: 400000, buildingsAsObstacles: false, smoothDem: false };

it("rupture preset reaches a plausible inundation", () => {
  const nx = 201, dx = 12;
  const x0 = -((nx - 1) / 2) * dx;
  // Gentle desert-like slope: 1.5 % falling to the east, with some undulation.
  const z = new Float32Array(nx * nx);
  for (let r = 0; r < nx; r++) for (let c = 0; c < nx; c++) {
    const x = x0 + c * dx, y = x0 + r * dx;
    z[r * nx + c] = 600 - 0.015 * x + 0.8 * Math.sin(x / 90) * Math.cos(y / 120);
  }
  const grid: Grid = { nx, ny: nx, x0, y0: x0, dx, z, crs: { lon0: 39.6111, lat0: 24.4672, unitScale: 1, proj4: "" } };
  const tank: TankSpec = { id: "r", name: "Bulk", shape: "cylindrical", capacityM3: 1000, diameterM: 12, wallHeightM: 10, waterHeadM: 10, baseElevationM: z[(nx * nx) / 2 | 0], location: { lng: 39.6111, lat: 24.4672 }, fluid: "water" };
  const scenario: ScenarioSpec = { mode: "catastrophic_breach", holeShape: "circular", holeElevationAboveBaseM: 0, dischargeCoefficientCd: 0.61, breachWidthM: 12, breachDevelopmentSeconds: 0 };
  const hydro = computeHydrograph(tank, scenario, tankGeometry(tank));
  const res = simulateShallowFlow({ grid, tank, scenario, hydro, options: OPTS });
  console.log("RESULT", { released: res.mass.releasedM3.toFixed(1), stored: res.mass.wetM3.toFixed(1), out: res.mass.outflowM3.toFixed(1), err: res.mass.errorPercent.toFixed(2), areaHa: (res.stats.affectedAreaM2/10000).toFixed(2), maxD: res.stats.maxDepthM.toFixed(2), ext: res.stats.maxExtentDistanceM.toFixed(0), ms: res.computeMs, vmax: res.stats.maxVelocityMs.toFixed(2), frames: res.frames.length });
  expect(Math.abs(res.mass.errorPercent)).toBeLessThan(1);
  expect(res.stats.affectedAreaM2).toBeGreaterThan(1000);
  // A 1 000 m3 release on a 1.5 % plane spreads into a sheet of a few centimetres — that is
  // the physically correct answer, not a deep flood.
  expect(res.stats.maxDepthM).toBeGreaterThan(0.02);
});
