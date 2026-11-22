import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapView, { DEFAULT_CENTER } from "./components/MapView";
import { TankPanel, ScenarioPanel, TerrainPanel, ResultsPanel, ImpactPanel, setVectorExportHandler } from "./components/Panels";
import ComparePanel from "./components/Compare";
import { useApp } from "./store";
import { availableBasemaps, fetchOsmAssets } from "./providers/basemaps";
import { computeExposure } from "./engine/exposure";
import { DEPTH_CLASSES, HAZARD_CLASSES } from "./engine/shallowFlow";
import { fmtArea, fmtDepth, fmtRate, fmtTime, fmtVolume, timestamp } from "./format";
import type { DemMetadata, SimulationResult } from "./engine/types";
import { LineChart } from "./components/Charts";
import { buildPng, mapSnapshotDataUrl } from "./export/png";
import { buildPdf } from "./export/pdf";
import {
  buildDamageGeoJson,
  buildDamageKmz,
  buildDamageShapefile,
  buildDxf,
} from "./export/vectors";
import { analyseDamage, analyseFlow } from "./analysis/impact";
import { damageLegendPng } from "./export/legend";
import { buildKmz } from "./export/kml";
import { buildExtentGeoJson, buildManifest } from "./export/geojson";
import type { ResultMessage, WorkerRequest } from "./workers/simulate.worker";
import { t as tr } from "./i18n";
import { readSaved, writeSaved, deleteSaved, downloadJson, encodePermalink, decodePermalink } from "./persist";
import type { ScenarioFile } from "./persist";

const APP_VERSION = "0.1.0";

/** Rebuilds a full SimulationResult from the worker payload (typed arrays are transferred). */
function hydrate(payload: ResultMessage["payload"]): { result: SimulationResult; dem: DemMetadata } {
  const grid = {
    nx: payload.grid.nx,
    ny: payload.grid.ny,
    dx: payload.grid.dx,
    x0: payload.grid.x0,
    y0: payload.grid.y0,
    z: new Float32Array(payload.grid.z),
    crs: payload.grid.crs,
  };
  const result: SimulationResult = {
    grid,
    maxDepth: new Float32Array(payload.maxDepth),
    arrivalTime: new Float32Array(payload.arrivalTime),
    maxVelocity: new Float32Array(payload.maxVelocity),
    wetDuration: new Float32Array(grid.nx * grid.ny),
    frames: payload.frames.map((b) => new Uint16Array(b)),
    frameTimes: payload.frameTimes,
    frameStats: payload.frameStats,
    depthClass: new Uint8Array(payload.depthClass),
    hazardClass: new Uint8Array(payload.hazardClass),
    mass: payload.mass,
    classes: payload.classes,
    stats: payload.stats,
    hydro: payload.hydro,
    options: payload.options,
    tankGroundElevationM: payload.tankGroundElevationM,
    damageClass: new Uint8Array(payload.damageClass),
    damageScore: new Uint8Array(payload.damageScore),
    damageBands: payload.damageBands,
    damageMethod: payload.damageMethod,
    flow: payload.flow,
    computeMs: payload.computeMs,
    hash: payload.hash,
    warnings: payload.warnings,
  };
  return { result, dem: payload.metadata };
}

/**
 * Save / load / share. Kept at the bottom of the sidebar so it is reachable from every tab,
 * and it never touches the results — a loaded scenario always has to be re-run.
 */
function ScenarioIO() {
  const tank = useApp((s) => s.tank);
  const scenario = useApp((s) => s.scenario);
  const options = useApp((s) => s.options);
  const demSourceId = useApp((s) => s.demSourceId);
  const layers = useApp((s) => s.layers);
  const loadInputs = useApp((s) => s.loadInputs);
  const setDemSource = useApp((s) => s.setDemSource);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>(Object.keys(readSaved()));

  const current = (): ScenarioFile => ({
    app: "TankBreach",
    version: 1,
    savedUtc: new Date().toISOString(),
    tank,
    scenario,
    options,
    demSourceId,
    layerVisibility: Object.fromEntries(layers.map((l) => [l.id, l.visible])),
  });

  const apply = (f: Partial<ScenarioFile>) => {
    loadInputs({ tank: f.tank ?? null, scenario: f.scenario, options: f.options });
    if (f.demSourceId) setDemSource(f.demSourceId);
    if (f.layerVisibility) {
      const st = useApp.getState();
      for (const [id, v] of Object.entries(f.layerVisibility)) {
        const l = st.layers.find((x) => x.id === id);
        if (l && l.visible !== v) st.toggleLayer(id as never);
      }
    }
    setNote("Scenario loaded — run the simulation to update the map.");
  };

  return (
    <>
      <h3 style={{ margin: "0 0 8px", fontSize: 11, letterSpacing: 0.7, color: "#93a4bd", textTransform: "uppercase" }}>
        Scenario file
      </h3>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <input
          placeholder="name this scenario"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="btn sm"
          disabled={!name.trim() || !tank}
          onClick={() => {
            writeSaved(name.trim(), current());
            setSaved(Object.keys(readSaved()));
            setNote(`Saved “${name.trim()}” in this browser.`);
          }}
        >
          Save
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => downloadJson(current(), "tankbreach-scenario.json")} disabled={!tank}>
          Download JSON
        </button>
        <label className="btn sm" style={{ cursor: "pointer" }}>
          Open JSON
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const parsed = JSON.parse(await f.text()) as ScenarioFile;
                if (parsed.app !== "TankBreach") throw new Error("not a TankBreach scenario file");
                apply(parsed);
              } catch (err) {
                setNote(`Could not read that file: ${(err as Error).message}`);
              }
            }}
          />
        </label>
        <button
          className="btn sm"
          onClick={async () => {
            const url = `${location.origin}${location.pathname}#s=${encodePermalink(current())}`;
            try {
              await navigator.clipboard.writeText(url);
              setNote("Shareable link copied to the clipboard.");
            } catch {
              setNote(url);
            }
          }}
          disabled={!tank}
        >
          Copy link
        </button>
      </div>
      {saved.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {saved.map((n) => (
            <span key={n} className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" onClick={() => apply(readSaved()[n])}>
                {n}
              </button>
              <button
                className="btn sm ghost"
                title="Delete"
                onClick={() => {
                  deleteSaved(n);
                  setSaved(Object.keys(readSaved()));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {note && (
        <div className="hint" style={{ marginTop: 6, wordBreak: "break-word" }} role="status">
          {note}
        </div>
      )}
    </>
  );
}

export default function App() {
  const s = useApp();
  const L = (k: Parameters<typeof tr>[1]) => tr(s.language, k);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef(0);
  const probeId = useRef(0);
  const compareLabel = useRef<string | null>(null);
  const playRef = useRef<number | null>(null);

  // Modern UI states
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [timelineMinimized, setTimelineMinimized] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- worker
  useEffect(() => {
    const w = new Worker(new URL("./workers/simulate.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.type === "progress" && msg.jobId === jobRef.current) {
        useApp.getState().setProgress(msg.fraction, msg.stage);
      } else if (msg.type === "result" && msg.jobId === jobRef.current) {
        const { result, dem } = hydrate(msg.payload);
        const st = useApp.getState();
        if (compareLabel.current) {
          compareQueue.current.out.push({ label: compareLabel.current, result });
          compareLabel.current = null;
          const next = compareQueue.current.remaining.shift();
          if (next) {
            compareLabel.current = next.label;
            const jobId = ++jobRef.current;
            st.setProgress(0.01, `Compare: ${next.label}`);
            workerRef.current?.postMessage({
              type: "simulate",
              jobId,
              tank: st.tank!,
              scenario: next.scenario,
              options: st.options,
              demSourceId: st.demSourceId,
            } as WorkerRequest);
            return;
          }
          st.setCompareResults(compareQueue.current.out, false);
          st.setProgress(1, "Compare complete");
          return;
        }
        if (typeof result.tankGroundElevationM === "number") {
          st.setDemElevationAtTank(result.tankGroundElevationM);
        }
        st.setResult(result, dem);
        st.setRunState("done");
        st.setProgress(1, "Complete");
        st.setSidebarTab("results");
        setRightDrawerOpen(true);
        // Exposure is fetched separately so a slow Overpass call never blocks the map.
        void runExposure(result);
      } else if (msg.type === "probeResult") {
        const st = useApp.getState();
        st.setDemProbeBusy(false);
        if (typeof msg.elevationM === "number") {
          st.setDemElevationAtTank(msg.elevationM);
          // Keep the tank floor on the ground unless the user has deliberately entered a
          // different value (elevated tanks use `baseAboveGroundM`, not this field).
          const t = st.tank;
          if (t && Math.abs(t.baseElevationM - msg.elevationM) > 2) {
            st.patchTank({ baseElevationM: Number(msg.elevationM.toFixed(2)) });
          }
        }
      } else if (msg.type === "error" && msg.jobId === jobRef.current) {
        const st = useApp.getState();
        st.setRunState("error");
        st.setError(msg.message);
      }
    };
    workerRef.current = w;
    useApp.setState({ runCompare });
    return () => w.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Samples the DEM at a point so the tank base elevation can be pre-filled. */
  const probeElevation = useCallback((lng: number, lat: number) => {
    const w = workerRef.current;
    if (!w) return;
    const st = useApp.getState();
    st.setDemProbeBusy(true);
    probeId.current += 1;
    w.postMessage({
      type: "probe",
      jobId: 900000 + probeId.current,
      lng,
      lat,
      demSourceId: st.demSourceId,
    } satisfies WorkerRequest);
  }, []);

  // On a phone the sidebar covers the map, so start with it closed.
  useEffect(() => {
    if (window.matchMedia("(max-width: 820px)").matches) useApp.getState().setSidebarOpen(false);
  }, []);

  // A permalink (#s=...) restores the inputs before anything else runs.
  useEffect(() => {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return;
    const f = decodePermalink(m[1]);
    if (!f) return;
    const st = useApp.getState();
    st.loadInputs({ tank: f.tank ?? null, scenario: f.scenario, options: f.options });
    if (f.demSourceId) st.setDemSource(f.demSourceId);
    if (f.layerVisibility) {
      for (const [id, v] of Object.entries(f.layerVisibility)) {
        const l = st.layers.find((x) => x.id === id);
        if (l && l.visible !== v) st.toggleLayer(id as never);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-fill the ground elevation for the opening tank location as soon as the app loads,
  // so the user never has to guess the base elevation. (The store starts with no tank; the
  // default map centre in Madinah is used until one is placed.)
  useEffect(() => {
    const t = useApp.getState().tank;
    if (t) {
      probeElevation(t.location.lng, t.location.lat);
    } else {
      probeElevation(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runExposure = useCallback(async (result: SimulationResult) => {
    const st = useApp.getState();
    const tank = st.tank;
    if (!tank) return;
    st.setExposureLoading(true);
    try {
      const radius = (result.grid.nx * result.grid.dx) / 2;
      const dLat = radius / 110900;
      const dLon = radius / (111320 * Math.cos((tank.location.lat * Math.PI) / 180));
      const assets = await fetchOsmAssets({
        west: tank.location.lng - dLon,
        south: tank.location.lat - dLat,
        east: tank.location.lng + dLon,
        north: tank.location.lat + dLat,
      });
      st.setOsmAssets(assets);
      if (assets.error) {
        st.setExposure(null);
      } else {
        st.setExposure(computeExposure(result, assets, result.options.reportingDepthM));
      }
    } catch (e: any) {
      st.setOsmAssets({
        buildings: [],
        roads: [],
        empty: true,
        fetchedAt: Date.now(),
        endpoint: "none",
        error: `Exposure could not be assessed: ${e?.message ?? e}. This is NOT the same as "no assets affected".`,
      });
    } finally {
      st.setExposureLoading(false);
    }
  }, []);

  const runSimulation = useCallback(() => {
    const st = useApp.getState();
    if (!st.tank) {
      st.setError("Place a tank on the map first.");
      st.setSidebarTab("tank");
      return;
    }
    if (!workerRef.current) return;
    const jobId = ++jobRef.current;
    st.setRunState("running");
    st.setError(null);
    st.setProgress(0.01, "Starting");
    st.setExposure(null);
    st.setOsmAssets(null);
    const req: WorkerRequest = {
      type: "simulate",
      jobId,
      tank: st.tank,
      scenario: st.scenario,
      options: st.options,
      demSourceId: st.demSourceId,
    };
    workerRef.current.postMessage(req);
  }, []);

  /**
   * Compare mode re-uses the same worker, running each scenario in turn. The queue lives in a
   * ref because each run has to wait for the previous result before starting the next.
   */
  const compareQueue = useRef<{ remaining: { label: string; scenario: typeof s.scenario }[]; out: { label: string; result: SimulationResult }[] }>({
    remaining: [],
    out: [],
  });

  const runCompare = useCallback(() => {
    const st = useApp.getState();
    if (!st.tank) {
      st.setError("Place a tank on the map first.");
      st.setSidebarTab("tank");
      return;
    }
    if (!workerRef.current) return;
    compareQueue.current = {
      remaining: st.compareRuns.map((r) => ({ label: r.label, scenario: r.scenario })),
      out: [],
    };
    st.setCompareResults([], true);
    st.setError(null);
    const next = compareQueue.current.remaining.shift();
    if (!next) return;
    const jobId = ++jobRef.current;
    st.setProgress(0.01, `Compare: ${next.label}`);
    workerRef.current.postMessage({
      type: "simulate",
      jobId,
      tank: st.tank,
      scenario: next.scenario,
      options: st.options,
      demSourceId: st.demSourceId,
    } as WorkerRequest);
    compareLabel.current = next.label;
  }, []);

  const cancelSimulation = useCallback(() => {
    const st = useApp.getState();
    st.setRunState("idle");
    st.setProgress(0, "Cancelled");
    workerRef.current?.postMessage({ type: "cancel", jobId: jobRef.current } as WorkerRequest);
    jobRef.current++; // orphan any late result
  }, []);

  // ---------------------------------------------------------------- geolocation
  // Lives here (not in the store) because it needs the map to fly to the result.
  useEffect(() => {
    useApp.setState({
      requestGeolocation: () => {
        if (!navigator.geolocation) {
          useApp.getState().setError("This browser does not expose a location.");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const lng = pos.coords.longitude;
            const lat = pos.coords.latitude;
            const st = useApp.getState();
            if (st.tank) st.patchTank({ location: { lng, lat } });
            probeElevation(lng, lat);
            window.dispatchEvent(new CustomEvent("tb:flyto", { detail: { lng, lat, zoom: 15 } }));
          },
          () => useApp.getState().setError("Could not read your location (permission denied)."),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- playback
  useEffect(() => {
    if (!s.playing || !s.result) {
      if (playRef.current) window.clearInterval(playRef.current);
      playRef.current = null;
      return;
    }
    const total = s.result.frames.length - 1;
    playRef.current = window.setInterval(() => {
      const st = useApp.getState();
      const next = st.frameIndex + 1;
      if (next > total) {
        st.setPlaying(false);
        return;
      }
      st.setFrameIndex(next);
    }, Math.max(40, 1000 / Math.max(0.5, s.playbackSpeed)));
    return () => {
      if (playRef.current) window.clearInterval(playRef.current);
    };
  }, [s.playing, s.result, s.playbackSpeed]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Escape") {
        setInfoModalOpen(false);
        setExportMenuOpen(false);
        setRightDrawerOpen(false);
        setFocusMode(false);
        return;
      }
      if (e.code === "KeyF") {
        setFocusMode((prev) => !prev);
        return;
      }
      if (!st.result) return;
      if (e.code === "Space") {
        e.preventDefault();
        st.setPlaying(!st.playing);
      } else if (e.code === "ArrowRight") {
        st.setFrameIndex(Math.min(st.result.frames.length - 1, st.frameIndex + 1));
      } else if (e.code === "ArrowLeft") {
        st.setFrameIndex(Math.max(0, st.frameIndex - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dismiss export dropdown on click outside
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    if (exportMenuOpen) {
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }
  }, [exportMenuOpen]);

  // ---------------------------------------------------------------- exports
  const grabCanvas = (): HTMLCanvasElement | null => {
    const el = document.querySelector(".maplibregl-canvas") as HTMLCanvasElement | null;
    return el ?? mapCanvasRef.current;
  };

  const doExport = async (
    kind: "png" | "pdf" | "kmz" | "geojson" | "manifest" | "damageGeojson" | "damageKmz" | "damageShp" | "damageDxf",
  ) => {
    const st = useApp.getState();
    const { result, tank, scenario, demMetadata } = st;
    if (!result || !tank) return;
    const base = `tankbreach_${(tank.name || "tank").replace(/\W+/g, "-")}_${timestamp()}`;
    const scenarioLabel =
      scenario.mode === "leak"
        ? `Leak ${((scenario.holeDiameterM ?? 0) * 1000).toFixed(0)} mm`
        : scenario.mode === "catastrophic_breach"
          ? `Breach ${scenario.breachWidthM} m`
          : "Overtopping";
    const attributions = [
      ...(availableBasemaps().find((b) => b.id === st.basemap)?.attribution
        ? [availableBasemaps().find((b) => b.id === st.basemap)!.attribution]
        : []),
      demMetadata?.attribution ?? "",
      "Buildings/roads © OpenStreetMap contributors (ODbL)",
    ].filter(Boolean);

    const download = (blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    if (kind === "damageGeojson") {
      const json = buildDamageGeoJson({
        result,
        areaKm2: st.impactAreaKm2,
        appVersion: APP_VERSION,
      });
      download(new Blob([json], { type: "application/geo+json" }), `${base}_damage_bands.geojson`);
      return;
    }
    if (kind === "damageKmz") {
      const legend = damageLegendPng(result, st.impactAreaKm2);
      const blob = await buildDamageKmz(
        { result, areaKm2: st.impactAreaKm2, appVersion: APP_VERSION },
        legend ?? undefined,
      );
      download(blob, `${base}_damage_bands.kmz`);
      return;
    }
    if (kind === "damageShp") {
      const bundle = await buildDamageShapefile({ result, areaKm2: st.impactAreaKm2, appVersion: APP_VERSION });
      download(bundle.blob, `${base}_${bundle.filename}`);
      return;
    }
    if (kind === "damageDxf") {
      download(
        new Blob([buildDxf({ result, areaKm2: st.impactAreaKm2, appVersion: APP_VERSION })], {
          type: "application/dxf",
        }),
        `${base}_damage_bands.dxf`,
      );
      return;
    }
    if (kind === "geojson") {
      download(new Blob([buildExtentGeoJson(result, st.exposure)], { type: "application/geo+json" }), `${base}.geojson`);
      return;
    }
    if (kind === "manifest") {
      download(
        new Blob([buildManifest(result, tank, scenario, demMetadata)], { type: "application/json" }),
        `${base}_manifest.json`,
      );
      return;
    }

    const canvas = grabCanvas();
    if (kind === "png") {
      try {
        if (!canvas) {
          alert("The map canvas is not ready yet. Please wait a moment and try again.");
          return;
        }
        const blob = await buildPng({
          mapCanvas: canvas,
          result,
          tank,
          scenarioLabel,
          demMetadata,
          attributions,
          basemapId: st.basemap,
          runHash: result.hash,
          scale: 2,
          includeBasemap: true,
        });
        download(blob, `${base}.png`);
      } catch (err: any) {
        console.error("PNG export error:", err);
        alert("Failed to export PNG: " + (err?.message ?? "Unknown error"));
      }
      return;
    }

    if (kind === "pdf") {
      try {
        const mapImage = canvas ? mapSnapshotDataUrl(canvas) : null;
        const blob = await buildPdf({
          tank,
          scenario,
          result,
          exposure: st.exposure,
          dem: demMetadata,
          mapImage,
          attribution: attributions.join(" · "),
          runHash: result.hash,
          appVersion: APP_VERSION,
          scenarioLabel,
        });
        download(blob, `${base}.pdf`);
      } catch (err: any) {
        console.warn("PDF export with map figure failed, falling back to clean vector report:", err);
        try {
          const blob = await buildPdf({
            tank,
            scenario,
            result,
            exposure: st.exposure,
            dem: demMetadata,
            mapImage: null,
            attribution: attributions.join(" · "),
            runHash: result.hash,
            appVersion: APP_VERSION,
            scenarioLabel,
          });
          download(blob, `${base}.pdf`);
        } catch (err2: any) {
          console.error("PDF export completely failed:", err2);
          alert("Failed to export PDF: " + (err2?.message ?? "Unknown error"));
        }
      }
      return;
    }

    if (kind === "kmz") {
      const blob = await buildKmz({
        tank,
        result,
        exposure: st.exposure,
        title: `${tank.name} — ${scenarioLabel}`,
        attribution: attributions.join(" · "),
        demLabel: demMetadata?.label ?? "unknown",
        demAccuracy: demMetadata?.verticalAccuracyM ?? null,
        runHash: result.hash,
        frameIndex: st.frameIndex,
      });
      download(blob, `${base}.kmz`);
    }
  };

  const exportComparisonPdf = useCallback(async () => {
    const { buildComparePdf } = await import("./export/pdf");
    const blob = await buildComparePdf({
      tank: s.tank!,
      dem: s.demMetadata,
      runs: s.compareResults,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tankbreach_comparison_${timestamp().replace(/[: ]/g, "-")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [s.tank, s.demMetadata, s.compareResults]);

  // The Impact panel triggers downloads through this hook, so it needs no prop plumbing.
  useEffect(() => {
    setVectorExportHandler((kind) => doExport(kind));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- derived
  const layer = (id: string) => s.layers.find((l) => l.id === id);
  const frame = s.result ? s.result.frames[Math.min(s.frameIndex, s.result.frames.length - 1)] : null;
  const frameTime = s.result ? s.result.frameTimes[Math.min(s.frameIndex, s.result.frameTimes.length - 1)] : 0;
  const frameStat = s.result?.frameStats[Math.min(s.frameIndex, s.result.frameStats.length - 1)];

  const activeBasemap = availableBasemaps().find((b) => b.id === s.basemap) ?? availableBasemaps()[0];
  const scenarioLabel = useMemo(() => {
    if (s.scenario.mode === "leak") return `Leak Ø${((s.scenario.holeDiameterM ?? 0) * 1000).toFixed(0)} mm`;
    if (s.scenario.mode === "catastrophic_breach") return `Breach ${s.scenario.breachWidthM} m`;
    return "Overtopping";
  }, [s.scenario]);

  /** Depth histogram for the current frame (10 bins up to the event max). */
  const hist = useMemo(() => {
    if (!frame || !s.result) return null;
    const bins = new Array(14).fill(0);
    const max = Math.max(0.05, s.result.stats.maxDepthM);
    for (let i = 0; i < frame.length; i++) {
      const d = frame[i] / 100;
      if (d <= 0) continue;
      const b = Math.min(bins.length - 1, Math.floor((d / max) * bins.length));
      bins[b]++;
    }
    return { bins, max };
  }, [frame, s.result]);

  return (
    <div className={`app ${focusMode ? "focus-mode" : ""}`} dir={s.language === "ar" ? "rtl" : "ltr"}>
      {/* ------------------------------------------------ top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span>TankBreach</span>
          <span className="brand-badge">2D Flood Screening</span>
        </div>

        <button
          className="btn ghost sm"
          style={{ gap: 5, fontSize: 11.5 }}
          onClick={() => setInfoModalOpen(true)}
          title="Methodology, Physics & Screening Governance"
        >
          <span style={{ color: "var(--accent)" }}>ℹ</span>
          <span>Methodology</span>
        </button>

        <div className="spacer" />

        {/* Action: Run / Cancel */}
        {s.runState === "running" ? (
          <button className="btn danger" onClick={cancelSimulation}>
            ■ {L("cancel")}
          </button>
        ) : (
          <button className="btn primary" onClick={runSimulation} disabled={!s.tank}>
            ▶ {L("run")}
          </button>
        )}

        {/* Focus / Presentation Mode */}
        <button
          className={`btn ${focusMode ? "primary" : "ghost"}`}
          onClick={() => setFocusMode(!focusMode)}
          title="Focus / Presentation Mode (Fullscreen map without sidebars)"
        >
          ⛶ {focusMode ? "Exit Focus" : "Focus"}
        </button>

        {/* Basemap Switcher */}
        <div className="seg" title="Basemap">
          {availableBasemaps().map((b) => (
            <button key={b.id} className={s.basemap === b.id ? "active" : ""} onClick={() => s.setBasemap(b.id)}>
              {b.label.replace(/\s*\(.*\)$/, "")}
            </button>
          ))}
        </div>

        {/* Consolidated Export Dropdown */}
        <div style={{ position: "relative" }} ref={exportMenuRef}>
          <button
            className={`btn ${exportMenuOpen ? "active" : ""}`}
            onClick={() => setExportMenuOpen(!exportMenuOpen)}
            disabled={!s.result}
            title="Export simulation results in presentation, GIS, or CAD formats"
          >
            📥 Export ▾
          </button>
          {exportMenuOpen && s.result && (
            <div className="dropdown-menu">
              <div className="dropdown-header">Presentations & Reports</div>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("png");
                }}
              >
                <span className="icon">📷</span> PNG High-Res Map
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("pdf");
                }}
              >
                <span className="icon">📄</span> PDF Formal Report
              </button>
              {s.compareResults.length >= 2 && (
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setExportMenuOpen(false);
                    exportComparisonPdf();
                  }}
                >
                  <span className="icon">📑</span> Comparison PDF ({s.compareResults.length} runs)
                </button>
              )}

              <div className="dropdown-divider" />
              <div className="dropdown-header">GIS & Geospatial</div>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("geojson");
                }}
              >
                <span className="icon">🌐</span> GeoJSON Extent
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("damageGeojson");
                }}
              >
                <span className="icon">🗺️</span> Damage Bands GeoJSON
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("damageShp");
                }}
              >
                <span className="icon">📦</span> Shapefile Bundle (SHP)
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("kmz");
                }}
              >
                <span className="icon">🌍</span> Google Earth (KMZ)
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("damageKmz");
                }}
              >
                <span className="icon">🏷️</span> Damage Bands KMZ
              </button>

              <div className="dropdown-divider" />
              <div className="dropdown-header">Engineering & CAD</div>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("damageDxf");
                }}
              >
                <span className="icon">📐</span> AutoCAD DXF Polylines
              </button>
              <button
                className="dropdown-item"
                onClick={() => {
                  setExportMenuOpen(false);
                  doExport("manifest");
                }}
              >
                <span className="icon">📋</span> Run Audit Manifest (JSON)
              </button>
            </div>
          )}
        </div>

        {/* Language selector */}
        <div className="seg" title={L("language")}>
          <button className={s.language === "en" ? "active" : ""} onClick={() => s.setLanguage("en")}>
            EN
          </button>
          <button className={s.language === "ar" ? "active" : ""} onClick={() => s.setLanguage("ar")}>
            العربية
          </button>
        </div>
      </header>

      {/* Focus Mode Exit Pill */}
      {focusMode && (
        <button
          className="focus-exit-btn"
          onClick={() => setFocusMode(false)}
          title="Exit Focus Mode (restore toolbars and panels)"
        >
          <span>✕</span>
          <span>Exit Focus</span>
        </button>
      )}

      {/* ------------------------------------------------ main */}
      <div className="main">
        <aside className={`sidebar ${s.sidebarOpen ? "" : "collapsed"}`}>
          <div className="tabs">
            {(["tank", "scenario", "terrain", "results", "impact", "compare"] as const).map((t) => (
              <button key={t} className={s.sidebarTab === t ? "active" : ""} onClick={() => s.setSidebarTab(t)}>
                {t === "tank"
                  ? L("tabTank")
                  : t === "scenario"
                    ? L("tabScenario")
                    : t === "terrain"
                      ? L("tabTerrain")
                      : t === "results"
                        ? L("tabResults")
                        : t === "impact"
                          ? L("tabImpact")
                          : "⇄"}
              </button>
            ))}
          </div>
          {s.sidebarTab === "tank" && <TankPanel />}
          {s.sidebarTab === "scenario" && <ScenarioPanel />}
          {s.sidebarTab === "terrain" && <TerrainPanel />}
          {s.sidebarTab === "results" && <ResultsPanel />}
          {s.sidebarTab === "impact" && <ImpactPanel />}
          {s.sidebarTab === "compare" && <ComparePanel />}
          <div className="panel-body" style={{ flex: "0 0 auto", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <ScenarioIO />
          </div>
          {s.sidebarTab !== "tank" && s.runState === "idle" && !s.tank && (
            <div className="panel-body">
              <div className="banner warn">Place a tank on the map first (Tank tab).</div>
            </div>
          )}
        </aside>

        <button
          className="sidebar-toggle-btn"
          style={{ left: s.sidebarOpen ? 396 : 14 }}
          onClick={() => s.setSidebarOpen(!s.sidebarOpen)}
          title={s.sidebarOpen ? "Hide panel" : "Show panel"}
        >
          {s.sidebarOpen ? "◀" : "▶"}
        </button>

        <MapView onTankMoved={probeElevation} />

        {/* ------------------------------------------------ right HUD & Analytics drawer */}
        {s.result && !focusMode && (
          <>
            {/* Minimal floating HUD pill when drawer is closed */}
            {!rightDrawerOpen && (
              <div
                className="hud-pill"
                onClick={() => setRightDrawerOpen(true)}
                title="Click to view detailed simulation impact & exposure analytics"
              >
                <div className="stat">
                  <span className="stat-label">Affected:</span>
                  <span>{fmtArea(s.result.stats.affectedAreaM2)}</span>
                </div>
                <div className="divider" />
                <div className="stat">
                  <span className="stat-label">Max depth:</span>
                  <span>{fmtDepth(s.result.stats.maxDepthM)}</span>
                </div>
                <div className="divider" />
                <div className="stat">
                  <span className="stat-label">Released:</span>
                  <span>{fmtVolume(s.result.mass.releasedM3)}</span>
                </div>
                <div className="divider" />
                <div className="hud-action">
                  <span>Analytics</span>
                  <span>▾</span>
                </div>
              </div>
            )}

            {/* Expanded Analytics Drawer */}
            {rightDrawerOpen && (
              <aside className="analytics-drawer">
                <div className="drawer-header">
                  <h3>
                    <span>📊</span>
                    <span>Modelled Analytics</span>
                  </h3>
                  <button
                    className="drawer-close-btn"
                    onClick={() => setRightDrawerOpen(false)}
                    title="Collapse analytics to free map space"
                  >
                    ✕
                  </button>
                </div>

                <div className="card">
                  <h3>Hydraulic Summary</h3>
                  <div className="grid2">
                    <div className="metric">
                      <span className="label">Affected area</span>
                      <span className="value">{fmtArea(s.result.stats.affectedAreaM2)}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Max depth</span>
                      <span className="value">{fmtDepth(s.result.stats.maxDepthM)}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Released</span>
                      <span className="value">{fmtVolume(s.result.mass.releasedM3)}</span>
                    </div>
                    <div className="metric">
                      <span className="label">Peak Q</span>
                      <span className="value">{fmtRate(s.result.hydro.peakQ)}</span>
                    </div>
                  </div>
                  <div
                    className={s.result.mass.ok ? "banner good" : "banner bad"}
                    style={{ marginTop: 8, fontSize: 11 }}
                    title="Released = stored + outflow + infiltration. The closing error must stay under 1 %."
                  >
                    Mass balance closes to {s.result.mass.errorPercent.toFixed(2)} %{" "}
                    {s.result.mass.ok ? "✓" : "— OUT OF TOLERANCE"}
                  </div>
                </div>

                <div className="card">
                  <h3>Asset Exposure</h3>
                  {s.exposureLoading ? (
                    <div style={{ color: "var(--muted)", display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                      <span className="spinner" /> Querying OpenStreetMap…
                    </div>
                  ) : s.exposure ? (
                    <div className="grid2">
                      <div className="metric">
                        <span className="label">Buildings exposed</span>
                        <span className="value">{s.exposure.totals.buildingCount}</span>
                      </div>
                      <div className="metric">
                        <span className="label">Roads exposed</span>
                        <span className="value">{(s.exposure.totals.roadAffectedM / 1000).toFixed(2)} km</span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "var(--warn)", fontSize: 11.5 }}>
                      {s.osmAssets?.error ? "Not assessed (Overpass unavailable)." : "Not assessed."}
                    </div>
                  )}
                </div>

                {hist && (
                  <div className="card">
                    <h3>Depth histogram at t = {fmtTime(frameTime)}</h3>
                    <DepthSpark bins={hist.bins} max={hist.max} />
                    <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
                      {frameStat ? `Wet area ${fmtArea(frameStat.wetAreaM2)} · max ${fmtDepth(frameStat.maxDepthM)}` : ""}
                    </div>
                  </div>
                )}

                {s.result.warnings.length > 0 && (
                  <div className="card">
                    <h3>Warnings & Diagnostics</h3>
                    <div style={{ color: "var(--warn)", fontSize: 11, maxHeight: 130, overflowY: "auto" }}>
                      {s.result.warnings.map((w, i) => (
                        <div key={i} style={{ marginBottom: 4 }}>
                          • {w}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </aside>
            )}
          </>
        )}

        {/* ------------------------------------------------ running overlay */}
        {s.runState === "running" && (
          <div
            className="card"
            style={{ position: "absolute", left: "50%", top: 64, transform: "translateX(-50%)", zIndex: 40, width: 330 }}
          >
            <h3>Simulating</h3>
            <div className="progressbar">
              <i style={{ width: `${Math.round(s.progress.fraction * 100)}%` }} />
            </div>
            <div style={{ marginTop: 6, color: "#93a4bd", fontSize: 11.5 }}>{s.progress.stage}</div>
          </div>
        )}

        {s.error && s.runState === "error" && (
          <div
            className="banner bad"
            style={{ position: "absolute", left: "50%", top: 64, transform: "translateX(-50%)", zIndex: 40, maxWidth: 480 }}
          >
            <b>Simulation failed.</b> {s.error}
            <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => s.setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* ------------------------------------------------ legend */}
        {s.showLegend && (
          <div
            className={`legend ${legendCollapsed ? "collapsed" : ""}`}
            style={{
              left: s.sidebarOpen && !focusMode ? 396 : 16,
              bottom: s.result ? 78 : 16,
            }}
          >
            <div className="card">
              <h3 onClick={() => setLegendCollapsed(!legendCollapsed)} title="Click to collapse / expand legend">
                <span>
                  {s.result && layer("damage")?.visible
                    ? "Damage bands"
                    : layer("hazard")?.visible
                    ? "Hazard to people"
                    : layer("arrival")?.visible
                      ? "Arrival time"
                      : layer("velocity")?.visible
                        ? "Peak velocity"
                        : "Modelled depth"}
                </span>
                <span style={{ fontSize: 10, color: "var(--muted)" }}>{legendCollapsed ? "▲" : "▼"}</span>
              </h3>

              <div className="legend-body" style={{ marginTop: 6 }}>
                {s.result && layer("damage")?.visible
                  ? (
                    <>
                      {/* Continuous ramp, matching the raster: pale yellow -> orange -> deep red. */}
                      <div
                        style={{
                          height: 10,
                          borderRadius: 3,
                          margin: "2px 0 6px",
                          background:
                            "linear-gradient(90deg,#fef08a 0%,#fde047 18%,#facc15 34%,#fb923c 50%,#f97316 66%,#dc2626 82%,#991b1b 100%)",
                        }}
                      />
                      {(s.result.damageBands ?? []).map((b) => (
                        <div className="swatch" key={b.id}>
                          <i style={{ background: b.colour }} />
                          <span>
                            {b.label} · {fmtArea(b.areaM2)}
                          </span>
                        </div>
                      ))}
                      <div style={{ color: "var(--dim)", fontSize: 10, marginTop: 3 }}>
                        Ramp is interpolated; swatches mark band limits
                      </div>
                    </>
                  )
                  : layer("hazard")?.visible
                  ? HAZARD_CLASSES.slice(1).map((h) => (
                      <div className="swatch" key={h.id}>
                        <i style={{ background: h.colour }} />
                        <span>{h.label}</span>
                      </div>
                    ))
                  : layer("arrival")?.visible
                    ? ["< 1 min", "1–5 min", "5–30 min", "30 min–2 h", "> 2 h"].map((l, i) => (
                        <div className="swatch" key={l}>
                          <i style={{ background: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"][i] }} />
                          <span>{l}</span>
                        </div>
                      ))
                    : layer("velocity")?.visible
                      ? ["0.1 m/s", "0.5 m/s", "1.0 m/s", "2.0+ m/s"].map((l, i) => (
                          <div className="swatch" key={l}>
                            <i style={{ background: ["#ffe08a", "#ffb347", "#fb7c3c", "#e53935"][i] }} />
                            <span>{l}</span>
                          </div>
                        ))
                      : DEPTH_CLASSES.map((c) => (
                          <div className="swatch" key={c.id}>
                            <i style={{ background: c.colour }} />
                            <span>{c.label}</span>
                          </div>
                        ))}
                <div style={{ color: "var(--dim)", fontSize: 10, marginTop: 5 }}>
                  Cell size {s.result ? `${s.result.grid.dx.toFixed(0)} m` : "—"} · threshold{" "}
                  {s.options.reportingDepthM} m
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------ timeline player */}
        {s.result && (
          <div className={`timeline ${timelineMinimized ? "minimized" : ""}`}>
            <button className="btn sm primary" onClick={() => s.setPlaying(!s.playing)} title="Play / pause (space)">
              {s.playing ? "⏸" : "▶"}
            </button>
            <button
              className="btn sm ghost"
              onClick={() => s.setFrameIndex(0)}
              title="Rewind to T = 0"
            >
              ⏮
            </button>
            <span className="tlabel">{fmtTime(frameTime)}</span>

            <div className="timeline-extended" style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
              <input
                type="range"
                min={0}
                max={s.result.frames.length - 1}
                value={s.frameIndex}
                onChange={(e) => s.setFrameIndex(Number(e.target.value))}
                aria-label="Simulation time"
              />
              <select
                value={s.playbackSpeed}
                onChange={(e) => s.setPlaybackSpeed(Number(e.target.value))}
                style={{
                  background: "rgba(10, 18, 32, 0.9)",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontSize: 11.5,
                }}
                title="Playback speed"
              >
                <option value={2}>0.5×</option>
                <option value={4}>1×</option>
                <option value={8}>2×</option>
                <option value={16}>4×</option>
              </select>
              <div className="live">
                <span>
                  Wet: <b>{frameStat ? fmtArea(frameStat.wetAreaM2) : "—"}</b>
                </span>
                <span>
                  Max depth: <b>{frameStat ? fmtDepth(frameStat.maxDepthM) : "—"}</b>
                </span>
                <span>
                  Outflow: <b>{frameStat ? fmtVolume(frameStat.outflowM3) : "—"}</b>
                </span>
              </div>
            </div>

            <button
              className="btn sm ghost"
              onClick={() => setTimelineMinimized(!timelineMinimized)}
              title={timelineMinimized ? "Expand timeline scrubber" : "Minimize timeline scrubber"}
              style={{ padding: "2px 6px", fontSize: 11 }}
            >
              {timelineMinimized ? "▲" : "▼"}
            </button>
          </div>
        )}

        <div className="attrib">
          {activeBasemap.attribution}
          {s.demMetadata ? ` · ${s.demMetadata.label}` : ""} · Buildings © OSM contributors
        </div>
      </div>

      {/* ------------------------------------------------ info & methodology modal */}
      {infoModalOpen && (
        <div className="modal-backdrop" onClick={() => setInfoModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <span style={{ color: "var(--accent)" }}>ℹ</span>
                <span>TankBreach Screening Methodology & Governance</span>
              </h2>
              <button className="drawer-close-btn" onClick={() => setInfoModalOpen(false)}>
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="banner warn">
                <b>Screening Tool Notice:</b> {L("disclaimerShort")} Always verify high-consequence findings with a licensed professional engineer before taking operational or life-safety actions.
              </div>

              <div className="card">
                <h3>Physical Formulation</h3>
                <p style={{ margin: "4px 0", color: "var(--text)", fontSize: 12 }}>
                  TankBreach solves the <b>2-D shallow-water equations</b> in inertial formulation (Bates, Horritt & Fewtrell 2010) on a regular cartesian grid.
                </p>
                <div className="kv" style={{ marginTop: 8 }}>
                  <dt>Governing equations</dt>
                  <dd>2-D Shallow Water (inertial form)</dd>
                  <dt>Time stepping</dt>
                  <dd>Adaptive CFL-limited sub-stepping</dd>
                  <dt>Surface friction</dt>
                  <dd>Manning's formulation (n = {s.options.manningN})</dd>
                  <dt>Mass conservation</dt>
                  <dd>Strict finite-volume cell balance (&lt; 1% closing tolerance)</dd>
                </div>
              </div>

              <div className="card">
                <h3>Key Screening Assumptions</h3>
                <ul style={{ margin: "4px 0 0 16px", padding: 0, color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>
                  <li>Release applied as surface inflow over the tank footprint.</li>
                  <li>Open boundary outfalls at all domain perimeter edges.</li>
                  <li>No sub-surface storm drain pipes, small culverts, or kerbs modelled.</li>
                  <li>Topography sampled from global DEM (Copernicus GLO-30 or AWS Terrain Tiles).</li>
                </ul>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn primary" onClick={() => setInfoModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DepthSpark({ bins, max }: { bins: number[]; max: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44 }}>
      {bins.map((b, i) => {
        const h = Math.max(1, (b / Math.max(...bins, 1)) * 42);
        const t = i / (bins.length - 1);
        return (
          <div
            key={i}
            title={`${(((i + 0.5) / bins.length) * max).toFixed(2)} m — ${b} cells`}
            style={{
              flex: 1,
              height: h,
              background: `hsl(${205 - 60 * t}, 85%, ${72 - 25 * t}%)`,
              borderRadius: "1px 1px 0 0",
            }}
          />
        );
      })}
    </div>
  );
}
