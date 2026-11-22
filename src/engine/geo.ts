/**
 * Local azimuthal-equidistant projection, implemented directly.
 *
 * Why: the whole hydraulic model must run in metres, not degrees. For a domain of
 * a few kilometres an azimuthal equidistant projection centred on the tank is
 * accurate to well under 0.1 % in distance, which is far below DEM accuracy.
 * Doing it in-house removes any dependency on proj4/DOM APIs so the engine runs
 * identically in a Web Worker, in Node (unit tests) and in the browser.
 */

import type { LocalCRS } from "./types";

export const WGS84_A = 6378137.0;
export const WGS84_E2 = 0.0066943799901413165;
export const DEG = Math.PI / 180;

/** Metres per degree of latitude at a given latitude (geodetic). */
export function metresPerDegLat(latDeg: number): number {
  const lat = latDeg * DEG;
  const s = Math.sin(lat);
  const w = 1 - WGS84_E2 * s * s;
  const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5); // meridional radius
  return M * DEG;
}

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegLon(latDeg: number): number {
  const lat = latDeg * DEG;
  const s = Math.sin(lat);
  const w = 1 - WGS84_E2 * s * s;
  const N = WGS84_A / Math.sqrt(w); // prime vertical radius
  return N * Math.cos(lat) * DEG;
}

export function makeLocalCRS(lon0: number, lat0: number): LocalCRS {
  return {
    lon0,
    lat0,
    unitScale: 1,
    proj4: `+proj=aeqd +lat_0=${lat0} +lon_0=${lon0} +datum=WGS84 +units=m +no_defs`,
  };
}

/**
 * Equirectangular / local tangent-plane forward projection (equidistant enough for
 * km-scale work). Returns {x: east metres, y: north metres}.
 */
export function project(lon: number, lat: number, crs: LocalCRS): { x: number; y: number } {
  // Latitude scale taken at the centre so the projection is exactly true along the
  // central meridian; the cos(lat) term is evaluated at the mean latitude of the
  // pair, which keeps error symmetric about the centre.
  const latMean = (lat + crs.lat0) / 2;
  const x = (lon - crs.lon0) * metresPerDegLon(latMean);
  const y = (lat - crs.lat0) * metresPerDegLat(latMean);
  return { x, y };
}

/** Inverse of {@link project}. */
export function unproject(x: number, y: number, crs: LocalCRS): { lng: number; lat: number } {
  const lat = crs.lat0 + y / metresPerDegLat(crs.lat0 + y / 2 / metresPerDegLat(crs.lat0));
  const latMean = (lat + crs.lat0) / 2;
  const lon = crs.lon0 + x / metresPerDegLon(latMean);
  return { lng: lon, lat };
}

/** Distance in metres between two lon/lat points (haversine on a sphere is plenty here). */
export function haversineM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lng - a.lng) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Web Mercator (EPSG:3857) helpers used by the tile fetcher and KMZ/PNG georeferencing. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const x = ((lng + 180) / 360) * n;
  const latRad = lat * DEG;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}
