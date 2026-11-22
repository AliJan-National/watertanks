/** GeoJSON export of the modelled extent + depth-class polygons + exposed assets. */

import type { SimulationResult } from "../engine/types";
import type { ExposureResult } from "../engine/exposure";

export function buildExtentGeoJson(
  result: SimulationResult,
  exposure: ExposureResult | null,
): string {
  const { nx, ny, dx, x0, y0, crs } = result.grid;
  const toLL = (x: number, y: number): [number, number] => {
    const lat = crs.lat0 + y / 110900;
    const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    return [Number((crs.lon0 + x / mLon).toFixed(7)), Number(lat.toFixed(7))];
  };
  const features: any[] = [];
  const thresh = result.options.reportingDepthM;

  // Depth-class cells emitted as small squares, merged by class is left to the GIS user
  // (vectorising 10^4-10^5 cells into dissolved polygons client-side is not worth the
  // runtime; QGIS/ArcGIS dissolve in a second).
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      const d = result.maxDepth[i];
      if (d < thresh) continue;
      const x = x0 + c * dx;
      const y = y0 + r * dx;
      features.push({
        type: "Feature",
        properties: {
          max_depth_m: Number(d.toFixed(3)),
          arrival_s: result.arrivalTime[i] >= 0 ? Number(result.arrivalTime[i].toFixed(0)) : null,
          peak_velocity_ms: Number(result.maxVelocity[i].toFixed(3)),
          depth_class: result.depthClass[i],
          hazard_class: result.hazardClass[i],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [toLL(x - dx / 2, y - dx / 2), toLL(x + dx / 2, y - dx / 2), toLL(x + dx / 2, y + dx / 2), toLL(x - dx / 2, y + dx / 2), toLL(x - dx / 2, y - dx / 2)],
          ],
        },
      });
    }
  }

  for (const b of exposure?.buildings ?? []) {
    features.push({
      type: "Feature",
      properties: {
        asset: "building",
        id: b.id,
        name: b.name ?? null,
        kind: b.kind ?? null,
        max_depth_m: Number(b.maxDepthM.toFixed(3)),
        arrival_s: b.arrivalTimeS >= 0 ? Number(b.arrivalTimeS.toFixed(0)) : null,
        footprint_area_m2: Number(b.footprintAreaM2.toFixed(1)),
      },
      geometry: { type: "Point", coordinates: [b.footprintCentroid.lng, b.footprintCentroid.lat] },
    });
  }

  return JSON.stringify(
    {
      type: "FeatureCollection",
      name: "TankBreach modelled inundation",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
      metadata: {
        generated: new Date().toISOString(),
        run_hash: result.hash,
        reporting_depth_m: thresh,
        cell_size_m: result.grid.dx,
        mass_balance: result.mass,
        disclaimer:
          "Screening tool output. Modelled extent, not observed flooding. Not for design or regulatory use without independent verification.",
      },
      features,
    },
    null,
    1,
  );
}

/** The run manifest, for exact reproduction of a result. */
export function buildManifest(result: SimulationResult, tank: any, scenario: any, dem: any): string {
  return JSON.stringify(
    {
      app: "TankBreach v0.1",
      runHash: result.hash,
      generatedUtc: new Date().toISOString(),
      tank,
      scenario,
      options: result.options,
      dem,
      grid: { nx: result.grid.nx, ny: result.grid.ny, dx: result.grid.dx, crs: result.grid.crs },
      results: {
        releasedM3: result.mass.releasedM3,
        affectedAreaM2: result.stats.affectedAreaM2,
        maxDepthM: result.stats.maxDepthM,
        maxVelocityMs: result.stats.maxVelocityMs,
        maxExtentDistanceM: result.stats.maxExtentDistanceM,
        peakDischargeM3s: result.hydro.peakQ,
        emptyTimeS: result.hydro.emptyTimeS,
        massBalance: result.mass,
        classes: result.classes,
      },
      warnings: result.warnings,
    },
    null,
    2,
  );
}
