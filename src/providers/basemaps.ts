/**
 * Basemap + vector asset providers.
 *
 * LICENSING — read this before changing anything here.
 * ------------------------------------------------------------------
 *  * Google (Map Tiles API): usable ONLY with a billed API key. Google's terms forbid
 *    caching, pre-fetching, offline storage and redistribution of tiles. The app supports
 *    it as an opt-in provider (GOOGLE_MAPS_API_KEY) and defaults to key-less sources so
 *    that a fresh install works with no account. Exported images containing Google tiles
 *    are the user's responsibility under Google's terms.
 *  * Esri World Imagery / World Street Map: publicly reachable tile services, subject to
 *    Esri's terms of use; attribution is embedded in every export.
 *  * OpenStreetMap data (streets): © OpenStreetMap contributors, ODbL. Tiles are fetched
 *    from the OSM tile servers at a modest rate for interactive use only — never for bulk
 *    download or offline caching.
 *  * OSM buildings/roads: Overpass API, ODbL.
 */

import type { StyleSpecification } from "maplibre-gl";

export interface BasemapDef {
  id: string;
  label: string;
  attribution: string;
  /** Raster XYZ tile template, or null for a vector style. */
  tiles?: string[];
  style?: StyleSpecification | string;
  maxZoom?: number;
}

const GOOGLE_KEY = (import.meta.env?.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? "";

export const BASEMAPS: BasemapDef[] = [
  {
    id: "satellite",
    label: "Satellite (Esri)",
    attribution:
      "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    maxZoom: 19,
  },
  {
    id: "streets",
    label: "Streets (CARTO Voyager)",
    // tile.openstreetmap.org refuses non-browser / bulk clients and returns a placeholder
    // here, so the streets layer uses the CARTO/OSM raster stack, which is CORS-friendly.
    attribution: "© OpenStreetMap contributors, © CARTO",
    tiles: [
      "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    ],
    maxZoom: 20,
  },
  {
    id: "light",
    label: "Light (CARTO)",
    attribution: "© OpenStreetMap contributors © CARTO",
    tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"],
    maxZoom: 20,
  },
  {
    id: "topo",
    label: "Topographic (Esri)",
    attribution: "© Esri, HERE, Garmin, USGS, OpenStreetMap contributors",
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    ],
    maxZoom: 19,
  },
];

/**
 * Google is opt-in and only offered when a key was configured at build time. The tile URL
 * below is the documented Google 2D tile endpoint; a session token is required and is the
 * caller's responsibility. No Google tiles are scraped or cached by this project.
 */
export function availableBasemaps(): BasemapDef[] {
  return GOOGLE_KEY ? [...BASEMAPS, googleBasemap(GOOGLE_KEY)] : BASEMAPS;
}

export function googleBasemap(apiKey: string): BasemapDef {
  return {
    id: "google_satellite",
    label: "Satellite (Google) — key required",
    attribution: "Imagery © Google",
    tiles: [
      `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=YOUR_SESSION&key=${apiKey}`,
    ],
  };
}

export const DEM_ATTRIBUTION =
  "Elevation: Mapzen/AWS Terrain Tiles (public domain) or Copernicus DEM (© DLR/ESA/Airbus)";

// ---------------------------------------------------------------- OSM assets

export interface OsmBuilding {
  id: string;
  rings: [number, number][][]; // lon/lat rings
  kind?: string;
  name?: string;
}

export interface OsmRoad {
  id: string;
  name?: string;
  highway?: string;
  /** Polyline in lon/lat. */
  coords: [number, number][];
}

export interface OsmAssets {
  buildings: OsmBuilding[];
  roads: OsmRoad[];
  /** Set when the query failed, so the UI can say "not assessed" instead of "zero". */
  error?: string;
  /** True when the bbox returned nothing, which in OSM usually means "unmapped". */
  empty: boolean;
  fetchedAt: number;
  endpoint: string;
}

const OVERPASS_ENDPOINTS = [
  (import.meta.env?.VITE_OVERPASS_URL as string | undefined) || "",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
].filter(Boolean);

/**
 * Fetches building footprints and roads from Overpass for a lon/lat bbox.
 * Building geometry is returned as closed ways + multipolygon relations (outer rings only).
 */
export async function fetchOsmAssets(
  bbox: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal,
): Promise<OsmAssets> {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `
[out:json][timeout:40];
(
  way["building"](${b});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|pedestrian|track)$"](${b});
  relation["building"](${b});
);
out geom tags;`.trim();

  let lastError: string | undefined;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    // A dead mirror must not leave the exposure panel spinning forever: give each endpoint a
    // hard 12 s budget, then fall through to the next and finally to "not assessed".
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!res.ok) {
        lastError = `Overpass ${endpoint} returned ${res.status}`;
        continue;
      }
      const json = (await res.json()) as any;
      const buildings: OsmBuilding[] = [];
      const roads: OsmRoad[] = [];
      for (const el of json.elements ?? []) {
        const tags = el.tags ?? {};
        if (el.type === "way" && el.geometry) {
          const coords: [number, number][] = el.geometry
            .filter((g: any) => g && Number.isFinite(g.lon) && Number.isFinite(g.lat))
            .map((g: any) => [g.lon, g.lat]);
          if (coords.length < 2) continue;
          if (tags.building) {
            if (coords.length >= 3) buildings.push({ id: `w${el.id}`, rings: [coords], kind: tags.building, name: tags.name });
          } else if (tags.highway) {
            roads.push({ id: `w${el.id}`, name: tags.name, highway: tags.highway, coords });
          }
        } else if (el.type === "relation" && el.members) {
          // Outer rings of a multipolygon building.
          const outer = el.members.filter((m: any) => m.role === "outer" && m.geometry);
          const rings: [number, number][][] = [];
          for (const m of outer) {
            const coords = m.geometry
              .filter((g: any) => g && Number.isFinite(g.lon) && Number.isFinite(g.lat))
              .map((g: any) => [g.lon, g.lat] as [number, number]);
            if (coords.length >= 3) rings.push(coords);
          }
          if (rings.length) buildings.push({ id: `r${el.id}`, rings, kind: tags.building, name: tags.name });
        }
      }
      return {
        buildings,
        roads,
        empty: buildings.length === 0,
        fetchedAt: Date.now(),
        endpoint,
      };
    } catch (e: any) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Only a caller-initiated cancel should propagate; a timeout is just a failed mirror.
      if (signal?.aborted) throw e;
      lastError = e?.name === "AbortError" ? `Overpass ${endpoint} timed out` : (e?.message ?? String(e));
    }
  }
  return {
    buildings: [],
    roads: [],
    empty: true,
    fetchedAt: Date.now(),
    endpoint: "none",
    error:
      `Could not reach any Overpass endpoint (${lastError ?? "unknown error"}). Building and road exposure is NOT assessed for this run — this is not the same as "no buildings affected".`,
  };
}

// ---------------------------------------------------------------- geocoding

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
}

/** Forward geocoding via Nominatim (OSM). 1 request/second policy; single-shot here. */
export async function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const json = (await res.json()) as any[];
  return json.map((r) => ({
    displayName: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}
