import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Feature } from "geojson";
import { availableBasemaps } from "../providers/basemaps";
import { useApp } from "../store";
import { unproject } from "../engine/geo";
import { gridCorners, paintRaster, paintHillshade, setRasterLayer } from "../map/rasterLayers";
import { sampleResult } from "../engine/exposure";
import { fmtDepth, fmtSpeed, fmtTime, fmtCoord } from "../format";
import { HAZARD_CLASSES } from "../engine/shallowFlow";
import { damageContours, damageScoreField, waterExtentRings } from "../analysis/contours";

export const DEFAULT_CENTER: [number, number] = [39.6111, 24.4672]; // Madinah

function styleFor(id: string): maplibregl.StyleSpecification {
  const def = availableBasemaps().find((b) => b.id === id) ?? availableBasemaps()[0];
  return {
    version: 8,
    sources: {
      base: {
        type: "raster",
        tiles: def.tiles,
        tileSize: 256,
        attribution: def.attribution,
        maxzoom: def.maxZoom ?? 19,
      },
      dem: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 15,
      },
    },
    layers: [{ id: "base", type: "raster", source: "base" }],
  } as maplibregl.StyleSpecification;
}

export default function MapView({ onTankMoved }: { onTankMoved?: (lng: number, lat: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [cursorLL, setCursorLL] = useState<{ lng: number; lat: number } | null>(null);

  const basemap = useApp((s) => s.basemap);
  const terrain3d = useApp((s) => s.terrain3d);
  const exaggeration = useApp((s) => s.terrainExaggeration);
  const tank = useApp((s) => s.tank);
  const placing = useApp((s) => s.placingTank);
  const layers = useApp((s) => s.layers);
  const result = useApp((s) => s.result);
  const frameIndex = useApp((s) => s.frameIndex);
  const setTank = useApp((s) => s.setTank);
  const setPlacingTank = useApp((s) => s.setPlacingTank);
  const patchTank = useApp((s) => s.patchTank);
  const exposure = useApp((s) => s.exposure);
  const impactAreaKm2 = useApp((s) => s.impactAreaKm2);

  // Blurring a 700 k-cell grid is not free, and the layer effect below re-runs on every
  // visibility/opacity change. Key it on the result so a toggle never repaints the field.
  const damageField = useMemo(() => (result ? damageScoreField(result) : undefined), [result]);

  // ---------------------------------------------------------------- init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleFor(basemap),
      center: DEFAULT_CENTER,
      zoom: 13.4,
      attributionControl: false,
      // The permalink lives in `#s=`, so MapLibre's own `hash` must stay off.
      hash: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
    });
    // Without `preserveDrawingBuffer` the WebGL drawing buffer is cleared after presentation
    // and the PNG/PDF exports would read back a blank canvas.
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    // Attribution is rendered by the app shell (one strip, mirrored correctly under RTL), so
    // MapLibre's own control would only duplicate it and collide with the timeline on phones.

    map.on("load", () => {
      registerArrowImage(map);
      setMapReady(true);
    });
    // A basemap switch rebuilds the style, which drops the arrow sprite with it.
    map.on("style.load", () => registerArrowImage(map));
    map.on("mousemove", (e) => setCursorLL({ lng: e.lngLat.lng, lat: e.lngLat.lat }));
    mapRef.current = map;
    // Dev-only handle for the e2e probes that inspect layer state (stripped from production builds).
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tbmap = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- basemap switching
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const style = map.getStyle();
    if (!style.sources.base) return;
    const def = availableBasemaps().find((b) => b.id === basemap) ?? availableBasemaps()[0];
    (map.getSource("base") as maplibregl.RasterTileSource).setTiles(def.tiles!);
  }, [basemap, mapReady]);

  // ---------------------------------------------------------------- click to place
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (useApp.getState().placingTank) {
        const s = useApp.getState();
        const base = s.tank?.baseElevationM ?? Math.round(sampleDemAt(map, e.lngLat.lng, e.lngLat.lat) ?? 0);
        setTank({
          id: s.tank?.id ?? "tank-1",
          name: s.tank?.name ?? "Storage tank",
          shape: s.tank?.shape ?? "cylindrical",
          capacityM3: s.tank?.capacityM3 ?? 1000,
          diameterM: s.tank?.diameterM ?? 12,
          lengthM: s.tank?.lengthM,
          widthM: s.tank?.widthM,
          wallHeightM: s.tank?.wallHeightM ?? 8,
          waterHeadM: s.tank?.waterHeadM ?? 8,
          baseElevationM: s.tank ? s.tank.baseElevationM : base,
          baseAboveGroundM: s.tank?.baseAboveGroundM ?? 0,
          location: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          fluid: s.tank?.fluid ?? "water",
        });
        setPlacingTank(false);
        useApp.getState().setSidebarTab("tank");
        onTankMoved?.(e.lngLat.lng, e.lngLat.lat);
        return;
      }
      // Query popup
      const res = useApp.getState().result;
      if (!res) return;
      const s = sampleResult(res, e.lngLat.lng, e.lngLat.lat);
      if (!s.inside) return;
      const hazard = s.depthM <= 0.001 ? 0 : s.depthM > 1.5 || s.depthM * s.velocityMs >= 1 ? 3 : s.depthM * s.velocityMs >= 0.5 ? 2 : 1;
      const html = `<div class="popup"><table>
        <tr><td>Modelled depth</td><td>${fmtDepth(s.depthM)}</td></tr>
        <tr><td>Arrival time</td><td>${s.arrivalS >= 0 ? fmtTime(s.arrivalS) : "not reached"}</td></tr>
        <tr><td>Peak velocity</td><td>${fmtSpeed(s.velocityMs)}</td></tr>
        <tr><td>Ground elevation</td><td>${s.groundM.toFixed(2)} m</td></tr>
        <tr><td>Hazard</td><td>${HAZARD_CLASSES[hazard].label.split("—")[0].trim()}</td></tr>
        <tr><td>Cell size</td><td>${res.grid.dx.toFixed(0)} m</td></tr>
      </table></div>`;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [setTank, setPlacingTank, onTankMoved]);

  // cursor style while placing
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = placing ? "crosshair" : "";
  }, [placing]);

  // ---------------------------------------------------------------- tank footprint + marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const id = "tank-src";
    const data: FeatureCollection = { type: "FeatureCollection", features: [] };
    if (tank) {
      const ring = footprintRing(tank);
      data.features.push({
        type: "Feature",
        properties: { name: tank.name },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
      if (map.getSource(id)) (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
      else {
        map.addSource(id, { type: "geojson", data });
        map.addLayer({
          id: "tank-fill",
          type: "fill",
          source: id,
          paint: { "fill-color": "#f59e0b", "fill-opacity": 0.35 },
        });
        map.addLayer({
          id: "tank-line",
          type: "line",
          source: id,
          paint: { "line-color": "#fbbf24", "line-width": 2 },
        });
      }
    } else if (map.getSource(id)) {
      (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    }
    // Simple draggable marker in the tank centre.
    const markerId = "tank-marker";
    let marker = (map as any)._tankMarker as maplibregl.Marker | undefined;
    if (tank) {
      if (!marker) {
        marker = new maplibregl.Marker({ color: "#f59e0b", draggable: true })
          .setLngLat([tank.location.lng, tank.location.lat])
          .addTo(map);
        marker.on("dragend", () => {
          const ll = marker!.getLngLat();
          const st = useApp.getState();
          st.patchTank({ location: { lng: ll.lng, lat: ll.lat } });
          onTankMoved?.(ll.lng, ll.lat);
        });
        (map as any)._tankMarker = marker;
      } else {
        marker.setLngLat([tank.location.lng, tank.location.lat]);
      }
    } else if (marker) {
      marker.remove();
      (map as any)._tankMarker = undefined;
    }
    void markerId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tank, mapReady]);

  // ---------------------------------------------------------------- fly-to requests
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onFly = (e: Event) => {
      const d = (e as CustomEvent<{ lng: number; lat: number; zoom?: number }>).detail;
      map.flyTo({ center: [d.lng, d.lat], zoom: d.zoom ?? 15, duration: 900 });
    };
    window.addEventListener("tb:flyto", onFly);
    return () => window.removeEventListener("tb:flyto", onFly);
  }, [mapReady]);

  // ---------------------------------------------------------------- fit to the damage bands
  useEffect(() => {
    const onFit = () => {
      const map = mapRef.current;
      const st = useApp.getState();
      const res = st.result;
      if (!map || !res) return;
      const c = gridCorners(res.grid);
      const b = new maplibregl.LngLatBounds(c[3], c[1]);
      const leftPad = st.sidebarOpen ? 410 : 70;
      map.fitBounds(b, { padding: { top: 75, bottom: 120, left: leftPad, right: 80 }, duration: 800, maxZoom: 16 });
    };
    window.addEventListener("tb:fitbands", onFit);
    return () => window.removeEventListener("tb:fitbands", onFit);
  }, []);

  // ---------------------------------------------------------------- 3-D terrain
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      if (terrain3d) {
        map.setTerrain({ source: "dem", exaggeration });
      } else {
        map.setTerrain(null);
      }
    } catch {
      // setTerrain can throw while the style is still loading; the next render retries.
    }
  }, [terrain3d, exaggeration, mapReady, basemap]);

  // ---------------------------------------------------------------- raster layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !result) return;
    const opts = {
      damageField,
      frameIndex,
      arrivalMaxS: Math.max(...result.arrivalTime.filter((v) => v >= 0).slice(0, 5000), 60),
      velocityMax: result.stats.maxVelocityMs,
    };
    const layerById = (id: string) => layers.find((l) => l.id === id);
    const map_ = (id: "maxDepth" | "depthNow" | "arrival" | "velocity" | "hazard", rasterId: any) => {
      const cfg = layerById(id);
      if (!cfg) return;
      const url = paintRaster(rasterId, result, opts);
      setRasterLayer(map, rasterId, url, result.grid, cfg.opacity, cfg.visible);
    };
    map_("maxDepth", "raster-maxDepth");
    map_("depthNow", "raster-depthNow");
    map_("arrival", "raster-arrival");
    map_("velocity", "raster-velocity");
    map_("hazard", "raster-hazard");
    // The heat map itself: a continuous ramp from the damage score, drawn under the contour
    // bands so the bands act as crisp iso-lines over an interpolated field.
    {
      const cfg = layerById("damage");
      if (cfg?.visible) {
        setRasterLayer(
          map,
          "raster-damage",
          paintRaster("raster-damage", result, opts),
          result.grid,
          Math.min(1, (cfg.opacity ?? 0.85) * 0.95),
          true,
        );
        if (map.getLayer("raster-damage")) map.moveLayer("raster-damage");
      } else if (map.getLayer("raster-damage")) {
        map.setLayoutProperty("raster-damage", "visibility", "none");
      }
    }

    const hs = layerById("hillshade");
    if (hs?.visible) {
      setRasterLayer(map, "raster-hillshade", paintHillshade(result.grid), result.grid, hs.opacity, true);
    } else if (map.getLayer("raster-hillshade")) {
      map.setLayoutProperty("raster-hillshade", "visibility", "none");
    }
  }, [result, layers, frameIndex, mapReady, damageField]);

  // ---------------------------------------------------------------- extent outline
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !result) return;
    const cfg = layers.find((l) => l.id === "extent");
    const data = extentPolygon(result);
    const id = "extent-src";
    if (map.getSource(id)) (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    else {
      map.addSource(id, { type: "geojson", data });
      map.addLayer({
        id: "extent-casing",
        type: "line",
        source: id,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 4.5,
          "line-opacity": 0.85,
          "line-blur": 0.6,
        },
      });
      map.addLayer({
        id: "extent-line",
        type: "line",
        source: id,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#0a0f1d",
          "line-width": 2.6,
          "line-opacity": 1.0,
        },
      });
    }
    const op = cfg?.opacity ?? 1.0;
    if (map.getLayer("extent-casing")) {
      map.setLayoutProperty("extent-casing", "visibility", cfg?.visible ? "visible" : "none");
      map.setPaintProperty("extent-casing", "line-opacity", op * 0.85);
      map.moveLayer("extent-casing");
    }
    if (map.getLayer("extent-line")) {
      map.setLayoutProperty("extent-line", "visibility", cfg?.visible ? "visible" : "none");
      map.setPaintProperty("extent-line", "line-opacity", op);
      map.moveLayer("extent-line");
    }
  }, [result, layers, mapReady]);

  // ---------------------------------------------------------------- exposed buildings
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const cfg = layers.find((l) => l.id === "buildings");
    const id = "exposed-buildings-src";
    const features = (exposure?.buildings ?? []).map((b) => ({
      type: "Feature" as const,
      properties: { depth: b.maxDepthM, name: b.name ?? "", kind: b.kind ?? "" },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [b.footprintCentroid.lng - 0.00005, b.footprintCentroid.lat - 0.00005],
            [b.footprintCentroid.lng + 0.00005, b.footprintCentroid.lat - 0.00005],
            [b.footprintCentroid.lng + 0.00005, b.footprintCentroid.lat + 0.00005],
            [b.footprintCentroid.lng - 0.00005, b.footprintCentroid.lat + 0.00005],
            [b.footprintCentroid.lng - 0.00005, b.footprintCentroid.lat - 0.00005],
          ],
        ],
      },
    }));
    const data = { type: "FeatureCollection" as const, features };
    if (map.getSource(id)) (map.getSource(id) as maplibregl.GeoJSONSource).setData(data as any);
    else {
      map.addSource(id, { type: "geojson", data: data as any });
      map.addLayer({
        id: "exposed-buildings",
        type: "circle",
        source: id,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "depth"], 0, 3, 2, 7],
          "circle-color": ["interpolate", ["linear"], ["get", "depth"], 0, "#fde68a", 0.3, "#fb923c", 1, "#dc2626"],
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 1,
        },
      });
    }
    if (map.getLayer("exposed-buildings")) {
      map.setLayoutProperty("exposed-buildings", "visibility", cfg?.visible ? "visible" : "none");
    }
  }, [exposure, layers, mapReady]);

  // ---------------------------------------------------------------- damage bands & flood extent
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const damageCfg = layers.find((l) => l.id === "damage");

    const bands = result ? damageHeatmapGeoJson(result) : { type: "FeatureCollection" as const, features: [] };

    // Clean up any lingering arrow or boundary layers/sources from previous runs
    for (const lid of [
      "flow-network-head-stroke",
      "flow-network-head-fill",
      "flow-network-core",
      "flow-network-casing",
      "impact-boundary-line",
    ]) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    }
    if (map.getSource("flow-network-src")) map.removeSource("flow-network-src");
    if (map.getSource("boundary-src")) map.removeSource("boundary-src");

    const put = (id: string, data: unknown, add: () => void, lineMetrics = false) => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data as any);
      else {
        map.addSource(id, { type: "geojson", data: data as any, lineMetrics });
        add();
      }
    };

    put("damage-src", bands, () => {
      // A soft, blurred halo sits underneath the bands so the field reads as a heat map
      // rather than as hard-edged islands.
      map.addLayer({
        id: "damage-halo",
        type: "fill",
        source: "damage-src",
        filter: ["==", ["get", "layer"], "halo"],
        paint: { "fill-color": ["get", "colour"], "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "damage-fill",
        type: "fill",
        source: "damage-src",
        filter: ["==", ["get", "layer"], "band"],
        paint: {
          "fill-color": ["get", "colour"],
          "fill-opacity": ["get", "opacity"],
        },
      });
      map.addLayer({
        id: "damage-outline",
        type: "line",
        source: "damage-src",
        filter: ["==", ["get", "layer"], "band"],
        paint: {
          "line-color": ["get", "colour"],
          "line-width": 1.0,
          "line-opacity": 0.18,
          "line-blur": 2.2,
        },
      });
    });

    if (map.getLayer("damage-fill")) {
      const scale = damageCfg?.opacity ?? 0.85;
      map.setPaintProperty("damage-fill", "fill-opacity", ["*", ["get", "opacity"], scale]);
      map.setPaintProperty("damage-halo", "fill-opacity", ["*", ["get", "opacity"], scale * 0.3]);
    }

    // These overlays sit above the depth rasters
    for (const id of [
      "damage-halo",
      "damage-fill",
      "damage-outline",
      "extent-casing",
      "extent-line",
    ]) {
      if (map.getLayer(id)) map.moveLayer(id);
    }

    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    vis("damage-halo", !!damageCfg?.visible);
    vis("damage-fill", !!damageCfg?.visible);
    vis("damage-outline", !!damageCfg?.visible);
  }, [result, layers, impactAreaKm2, mapReady]);

  // ---------------------------------------------------------------- fit to result
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !result) return;
    const c = gridCorners(result.grid);
    const b = new maplibregl.LngLatBounds(c[3], c[1]);
    map.fitBounds(b, { padding: { top: 60, bottom: 120, left: 420, right: 360 }, duration: 700, maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.hash]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-canvas" />
      {cursorLL && (
        <div
          style={{
            position: "absolute",
            left: 8,
            top: 8,
            zIndex: 12,
            background: "rgba(6,12,22,0.72)",
            border: "1px solid #24344f",
            borderRadius: 6,
            padding: "2px 7px",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
            color: "#cbd5e1",
          }}
        >
          {fmtCoord(cursorLL.lat)}°N, {fmtCoord(cursorLL.lng)}°E
        </div>
      )}
      {placing && (
        <div className="banner info" style={{ position: "absolute", top: 44, left: "50%", transform: "translateX(-50%)", zIndex: 20 }}>
          Click the map to place the tank
        </div>
      )}
    </div>
  );
}

/** Samples the terrain elevation at a point using MapLibre's raster-dem (needs the DEM source loaded). */
function sampleDemAt(map: MapLibreMap, lng: number, lat: number): number | null {
  try {
    const el = map.queryTerrainElevation?.([lng, lat]);
    if (typeof el === "number" && Number.isFinite(el)) return el;
  } catch {
    /* terrain not enabled */
  }
  return null;
}

/** Circular footprint (equal-area) for display, in lon/lat, honouring rectangular tanks. */
function footprintRing(tank: NonNullable<ReturnType<typeof useApp.getState>["tank"]>): [number, number][] {
  const lat = tank.location.lat;
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let rx = 6;
  let ry = 6;
  if (tank.shape === "cylindrical" || tank.shape === "horizontal_cylindrical" || tank.shape === "spherical_partial") {
    rx = ry = (tank.diameterM ?? 12) / 2;
  } else {
    rx = (tank.lengthM ?? 20) / 2;
    ry = (tank.widthM ?? 20) / 2;
  }
  const pts: [number, number][] = [];
  const n = 32;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([tank.location.lng + (Math.cos(a) * rx) / mLon, tank.location.lat + (Math.sin(a) * ry) / 110900]);
  }
  return pts;
}

/** Builds the smooth, fluent organic extent outline of the flood footprint. */
function extentPolygon(result: ReturnType<typeof useApp.getState>["result"]): FeatureCollection {
  if (!result) return { type: "FeatureCollection", features: [] };
  const rings = waterExtentRings(result);
  const features: Feature[] = rings.map((ring) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: ring },
  }));
  return { type: "FeatureCollection", features };
}

/**
 * Small canvas arrowhead, registered as a map image. Drawing it once is much cheaper than
 * a symbol per arrow with an SDF font glyph, and it rotates cleanly with icon-rotate.
 */
function registerArrowImage(map: MapLibreMap) {
  const size = 32;
  if (!map.hasImage("arrow-head")) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.translate(size / 2, size / 2);
      ctx.fillStyle = "#0284c7";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      // Points north by default; MapLibre rotates clockwise from north for icon-rotate.
      ctx.moveTo(0, -12);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 3);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const data = ctx.getImageData(0, 0, size, size);
      map.addImage("arrow-head", { width: size, height: size, data: new Uint8Array(data.data) });
    }
  }
  if (!map.hasImage("arrow-pulse")) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.translate(size / 2, size / 2);
      ctx.fillStyle = "#38bdf8";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 3);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const data = ctx.getImageData(0, 0, size, size);
      map.addImage("arrow-pulse", { width: size, height: size, data: new Uint8Array(data.data) });
    }
  }
}

/**
 * Damage bands as smooth contour polygons (a heat map), not one rectangle per cell.
 *
 * Each band contributes: a soft halo ring (the same contour grown by drawing it underneath at
 * low opacity) plus the band ring itself. Bands are emitted low → high so the strongest colour
 * paints last, and opacity increases with severity so deep water dominates visually.
 */
function damageHeatmapGeoJson(result: NonNullable<ReturnType<typeof useApp.getState>["result"]>): FeatureCollection {
  const features: Feature[] = [];
  const bands = damageContours(result);
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  // Iso-band fills stay light: the continuous raster underneath carries the colour ramp, and
  // these only reinforce the band boundaries. Heavy fills here turn the map back into flat
  // islands and hide the gradient.
  const opacity: Record<string, number> = { low: 0.05, medium: 0.07, high: 0.10 };
  const sorted = [...bands].sort((a, b) => rank[a.id] - rank[b.id]);
  for (const band of sorted) {
    for (const poly of band.polygons) {
      features.push({
        type: "Feature",
        properties: { layer: "halo", colour: band.colour, opacity: opacity[band.id], band: band.id },
        geometry: { type: "Polygon", coordinates: poly },
      });
    }
  }
  for (const band of sorted) {
    for (const poly of band.polygons) {
      features.push({
        type: "Feature",
        properties: { layer: "band", colour: band.colour, opacity: opacity[band.id], band: band.id },
        geometry: { type: "Polygon", coordinates: poly },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Small curved dashed flow arrows radiating from the tank in active flood directions. */
function flowNetworkGeoJson(
  result: NonNullable<ReturnType<typeof useApp.getState>["result"]>,
): FeatureCollection {
  const features: Feature[] = [];
  const network = result.flow?.flowNetwork ?? [];

  for (const branch of network) {
    if (branch.path && branch.path.length >= 2) {
      features.push({
        type: "Feature",
        properties: {
          kind: "shaft",
          id: branch.id,
          role: branch.role,
          bearingDeg: branch.bearingDeg,
          lengthM: branch.lengthM,
        },
        geometry: {
          type: "LineString",
          coordinates: branch.path,
        },
      });
    }

    if (branch.arrowHead && branch.arrowHead.length >= 3) {
      features.push({
        type: "Feature",
        properties: {
          kind: "head",
          id: `${branch.id}-head`,
          role: branch.role,
        },
        geometry: {
          type: "Polygon",
          coordinates: [branch.arrowHead],
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

/** The assessment boundary square, in lon/lat. */
function boundaryGeoJson(
  result: NonNullable<ReturnType<typeof useApp.getState>["result"]>,
  areaKm2: number,
): FeatureCollection {
  const { dx, x0, y0, crs } = result.grid;
  const half = Math.sqrt(Math.max(0.0001, areaKm2) * 1e6) / 2;
  const cx = x0 + ((result.grid.nx - 1) / 2) * dx;
  const cy = y0 + ((result.grid.ny - 1) / 2) * dx;
  const corner = (x: number, y: number) => {
    const ll = unproject(x, y, crs);
    return [ll.lng, ll.lat];
  };
  const ring = [
    corner(cx - half, cy - half),
    corner(cx + half, cy - half),
    corner(cx + half, cy + half),
    corner(cx - half, cy + half),
    corner(cx - half, cy - half),
  ];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { areaKm2 },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}
