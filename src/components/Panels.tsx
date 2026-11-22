import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import { PRESETS, MANNING_PRESETS, tankFromPreset, DEFAULT_OPTIONS } from "../presets";
import { tankGeometry, computeHydrograph, G } from "../engine/hydrograph";
import { DEPTH_CLASSES, HAZARD_CLASSES } from "../engine/shallowFlow";
import { DEM_SOURCES } from "../providers/dem";
import { fmtDepth, fmtRate, fmtReleaseTime, fmtTime, fmtVolume, fmtArea, fmtLength } from "../format";
import { LineChart, Histogram } from "./Charts";
import type { TankShape } from "../engine/types";
import { analyseDamage, analyseFlow, compassLabel } from "../analysis/impact";

const Num = ({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  unit,
  hint,
  error,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) => (
  <div className="field">
    <label>
      <span>
        {label} {unit && <span className="hint">{unit}</span>}
      </span>
      {hint && <span className="hint">{hint}</span>}
    </label>
    <input
      type="number"
      value={Number.isFinite(value as number) ? (value as number) : ""}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
    {error && <div className="err">{error}</div>}
  </div>
);

export function TankPanel() {
  const tank = useApp((s) => s.tank);
  const patchTank = useApp((s) => s.patchTank);
  const setTank = useApp((s) => s.setTank);
  const patchScenario = useApp((s) => s.patchScenario);
  const setPlacing = useApp((s) => s.setPlacingTank);
  const requestGeolocation = useApp((s) => s.requestGeolocation);
  const demMeta = useApp((s) => s.demMetadata);
  const demElev = useApp((s) => s.demElevationAtTank);
  const demProbeBusy = useApp((s) => s.demProbeBusy);
  const [presetId, setPresetId] = useState("");

  const geom = useMemo(() => (tank ? tankGeometry(tank) : null), [tank]);
  const capacityMismatch = tank && geom ? Math.abs(geom.geometricCapacityM3 - tank.capacityM3) / Math.max(1, tank.capacityM3) : 0;
  const headError = tank && tank.waterHeadM > tank.wallHeightM + 1e-6 ? "Water level cannot exceed the wall height (add freeboard instead)." : undefined;

  return (
    <div className="panel-body">
      <div className="banner info" style={{ marginBottom: 10 }}>
        <b>Screening tool.</b> Not a design-grade dam-break study. Results depend on DEM accuracy
        ({demMeta ? `±${demMeta.verticalAccuracyM ?? "?"} m` : "typically ±2–4 m"}) and on simplified hydraulics.
      </div>

      <div className="field">
        <label>
          <span>Start from a preset</span>
        </label>
        <select
          value={presetId}
          onChange={(e) => {
            setPresetId(e.target.value);
            const p = PRESETS.find((x) => x.id === e.target.value);
            if (!p) return;
            const loc = tank?.location ?? { lng: 39.6111, lat: 24.4672 };
            const base = demElev ?? tank?.baseElevationM ?? 600;
            // A preset is a complete scenario, not just a tank: apply its release mode as
            // well, otherwise the rupture preset would silently run with whatever leak the
            // user previously had selected.
            const t = tankFromPreset(p, loc.lng, loc.lat, base);
            // If the DEM has already been sampled at this location, sit the preset on the
            // actual ground rather than a hard-coded elevation.
            if (demElev !== null) t.baseElevationM = Number(demElev.toFixed(2));
            setTank(t);
            patchScenario(p.scenario);
          }}
        >
          <option value="">— choose a scenario preset —</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} — {p.blurb}
            </option>
          ))}
        </select>
      </div>

      {!tank ? (
        <div className="banner warn" style={{ marginTop: 10 }}>
          No tank placed yet. Click <b>Place tank</b> and then click on the map — or pick a preset above and
          move the marker.
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn" onClick={() => setPlacing(true)}>
              📍 Move / place tank
            </button>
            <button className="btn ghost" onClick={() => setTank(null)}>
              Clear
            </button>
            <button className="btn ghost" onClick={requestGeolocation} title="Use my location">
              ⌖ My location
            </button>
          </div>

          <div className="field">
            <label>
              <span>Tank name</span>
            </label>
            <input type="text" value={tank.name} onChange={(e) => patchTank({ name: e.target.value })} />
          </div>

          <div className="row">
            <Num
              label="Longitude"
              unit="°"
              value={Number(tank.location.lng.toFixed(6))}
              step={0.00001}
              onChange={(v) => patchTank({ location: { ...tank.location, lng: v } })}
            />
            <Num
              label="Latitude"
              unit="°"
              value={Number(tank.location.lat.toFixed(6))}
              step={0.00001}
              onChange={(v) => patchTank({ location: { ...tank.location, lat: v } })}
            />
          </div>

          <div className="field">
            <label>
              <span>Shape</span>
            </label>
            <select value={tank.shape} onChange={(e) => patchTank({ shape: e.target.value as TankShape })}>
              <option value="cylindrical">Vertical cylinder</option>
              <option value="horizontal_cylindrical">Horizontal cylinder</option>
              <option value="rectangular">Rectangular / box</option>
              <option value="spherical_partial">Spherical (part filled)</option>
            </select>
          </div>

          {tank.shape === "rectangular" ? (
            <div className="row">
              <Num label="Length" unit="m" value={tank.lengthM} step={0.5} onChange={(v) => patchTank({ lengthM: v })} />
              <Num label="Width" unit="m" value={tank.widthM} step={0.5} onChange={(v) => patchTank({ widthM: v })} />
            </div>
          ) : (
            <Num label="Diameter" unit="m" value={tank.diameterM} step={0.5} onChange={(v) => patchTank({ diameterM: v })} />
          )}

          <div className="row">
            <Num
              label="Wall height"
              unit="m"
              value={tank.wallHeightM}
              step={0.1}
              onChange={(v) => patchTank({ wallHeightM: v, waterHeadM: Math.min(tank.waterHeadM, v) })}
            />
            <Num
              label="Water level"
              unit="m"
              value={tank.waterHeadM}
              step={0.1}
              max={tank.wallHeightM}
              onChange={(v) => patchTank({ waterHeadM: v })}
              error={headError}
            />
          </div>

          <div className="field">
            <label>
              <span>Fill level</span>
              <span className="hint">{((tank.waterHeadM / Math.max(0.01, tank.wallHeightM)) * 100).toFixed(0)} % of wall height</span>
            </label>
            <input
              type="range"
              min={0}
              max={tank.wallHeightM}
              step={0.05}
              value={tank.waterHeadM}
              onChange={(e) => patchTank({ waterHeadM: Number(e.target.value) })}
            />
          </div>

          <div className="row">
            <Num
              label="Nameplate capacity"
              unit="m³"
              value={tank.capacityM3}
              step={10}
              onChange={(v) => patchTank({ capacityM3: v })}
            />
            <div className="field">
              <label>
                <span>Computed from dimensions</span>
              </label>
              <input type="text" readOnly value={geom ? `${geom.geometricCapacityM3.toFixed(1)} m³` : "—"} />
            </div>
          </div>
          {capacityMismatch > 0.05 && geom && (
            <div className="banner warn" style={{ marginBottom: 9 }}>
              The dimensions give <b>{geom.geometricCapacityM3.toFixed(0)} m³</b> but the nameplate says{" "}
              <b>{tank.capacityM3.toFixed(0)} m³</b> (
              {((geom.geometricCapacityM3 / Math.max(1, tank.capacityM3) - 1) * 100).toFixed(0)} % difference). The
              simulation uses the geometry — adjust the dimensions if the nameplate is correct.
            </div>
          )}

          <Num
            label="Tank floor elevation"
            unit="m a.s.l."
            value={Number(tank.baseElevationM.toFixed(2))}
            step={0.1}
            onChange={(v) => patchTank({ baseElevationM: v })}
            hint="sample DEM"
          />
          <div className="row" style={{ marginTop: -4, marginBottom: 8 }}>
            <span style={{ color: "#6b7f9c", fontSize: 11 }}>
              DEM at tank:{" "}
              {demProbeBusy
                ? "sampling…"
                : demElev !== null
                  ? `${demElev.toFixed(2)} m`
                  : "— (run a simulation or move the tank)"}
            </span>
            {demElev !== null && (
              <button className="btn sm ghost" onClick={() => patchTank({ baseElevationM: Number(demElev.toFixed(2)) })}>
                Use DEM value
              </button>
            )}
          </div>

          <Num
            label="Base above ground (elevated tanks)"
            unit="m"
            value={tank.baseAboveGroundM ?? 0}
            step={0.5}
            onChange={(v) => patchTank({ baseAboveGroundM: v })}
            hint="not modelled as head"
          />
          <div className="sub" style={{ color: "#6b7f9c", fontSize: 11, marginTop: -6, marginBottom: 8 }}>
            An elevated tank adds head but the release is applied at the ground surface; the drop is not simulated.
          </div>

          <div className="field">
            <label>
              <span>Fluid</span>
            </label>
            <select value={tank.fluid} onChange={(e) => patchTank({ fluid: e.target.value as any })}>
              <option value="water">Potable / raw water</option>
              <option value="wastewater">Wastewater</option>
              <option value="brine">Brine / industrial</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

export function ScenarioPanel() {
  const sc = useApp((s) => s.scenario);
  const patch = useApp((s) => s.patchScenario);
  const tank = useApp((s) => s.tank);

  const hydro = useMemo(() => {
    if (!tank) return null;
    try {
      return computeHydrograph(tank, sc, tankGeometry(tank));
    } catch {
      return null;
    }
  }, [tank, sc]);

  const geom = tank ? tankGeometry(tank) : null;

  const qSeries = hydro ? hydro.points.slice(0, 400).map((p) => ({ x: p.t, y: p.q })) : [];

  return (
    <div className="panel-body">
      <div
        style={{
          background: "linear-gradient(135deg, rgba(30, 58, 138, 0.2) 0%, rgba(15, 23, 42, 0.35) 100%)",
          border: "1px solid rgba(56, 189, 248, 0.25)",
          borderRadius: 8,
          padding: 8,
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", marginBottom: 6 }}>
          🏛️ Municipal Study Cases
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn sm ${sc.mode === "leak" && sc.holeDiameterM === 0.15 ? "primary" : ""}`}
            style={{ flex: 1, fontSize: 11 }}
            onClick={() =>
              patch({
                mode: "leak",
                holeShape: "circular",
                holeDiameterM: 0.15,
                holeElevationAboveBaseM: 0,
                dischargeCoefficientCd: 0.61,
              })
            }
            title="Wall puncture leak: 150 mm opening, low discharge, nuisance ponding"
          >
            Case 1: Leak (150 mm)
          </button>
          <button
            type="button"
            className={`btn sm ${sc.mode === "catastrophic_breach" && sc.breachWidthM === 8 ? "primary" : ""}`}
            style={{ flex: 1, fontSize: 11 }}
            onClick={() =>
              patch({
                mode: "catastrophic_breach",
                breachWidthM: 8,
                breachDevelopmentSeconds: 0,
                dischargeCoefficientCd: 0.61,
              })
            }
            title="Catastrophic breach: 8 m wall failure, violent surge, downstream hazard"
          >
            Case 2: Breach (8 m)
          </button>
        </div>
      </div>

      <div className="field">
        <label>
          <span>Scenario type</span>
        </label>
        <select value={sc.mode} onChange={(e) => patch({ mode: e.target.value as any })}>
          <option value="leak">Leak / hole in the wall or base</option>
          <option value="catastrophic_breach">Catastrophic breach (wall failure)</option>
          <option value="overtopping">Overtopping / spill over the wall crest</option>
        </select>
      </div>

      {sc.mode === "leak" && (
        <>
          <div className="field">
            <label>
              <span>Opening shape</span>
            </label>
            <select
              value={sc.holeShape}
              onChange={(e) => patch({ holeShape: e.target.value as any })}
            >
              <option value="circular">Circular (pipe / hole)</option>
              <option value="rectangular">Rectangular</option>
            </select>
          </div>
          {sc.holeShape === "circular" ? (
            <Num
              label="Hole diameter"
              unit="m"
              value={sc.holeDiameterM}
              step={0.005}
              min={0.001}
              onChange={(v) => patch({ holeDiameterM: v })}
              hint={sc.holeDiameterM ? `${(sc.holeDiameterM * 1000).toFixed(0)} mm` : undefined}
            />
          ) : (
            <div className="row">
              <Num label="Opening width" unit="m" value={sc.holeWidthM} step={0.01} onChange={(v) => patch({ holeWidthM: v })} />
              <Num label="Opening height" unit="m" value={sc.holeHeightM} step={0.01} onChange={(v) => patch({ holeHeightM: v })} />
            </div>
          )}
          <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            {[0.01, 0.05, 0.1, 0.25, 0.5].map((d) => (
              <button key={d} className="btn sm" onClick={() => patch({ holeDiameterM: d, holeShape: "circular" })}>
                {d * 1000} mm
              </button>
            ))}
          </div>
        </>
      )}

      {(sc.mode === "catastrophic_breach" || sc.mode === "overtopping") && (
        <>
          <Num
            label="Breach width"
            unit="m"
            value={sc.breachWidthM}
            step={0.5}
            min={0.5}
            onChange={(v) => patch({ breachWidthM: v })}
          />
          <Num
            label="Breach development time"
            unit="s"
            value={sc.breachDevelopmentSeconds ?? 0}
            step={10}
            min={0}
            onChange={(v) => patch({ breachDevelopmentSeconds: v })}
            hint={!sc.breachDevelopmentSeconds ? "instantaneous" : undefined}
          />
        </>
      )}

      {sc.mode !== "overtopping" && (
        <Num
          label="Opening invert above tank floor"
          unit="m"
          value={sc.holeElevationAboveBaseM}
          step={0.1}
          min={0}
          max={tank?.wallHeightM ?? 10}
          onChange={(v) => patch({ holeElevationAboveBaseM: v })}
          hint="0 = bottom hole"
        />
      )}

      <div className="row">
        <Num
          label="Discharge coefficient Cd"
          value={sc.dischargeCoefficientCd}
          step={0.01}
          min={0.1}
          max={1}
          onChange={(v) => patch({ dischargeCoefficientCd: v })}
          hint="0.61 sharp-edged"
        />
        <Num
          label="Release duration"
          unit="s"
          value={sc.durationSeconds ?? 0}
          step={60}
          min={0}
          onChange={(v) => patch({ durationSeconds: v > 0 ? v : undefined })}
          hint={!sc.durationSeconds ? "until empty" : undefined}
        />
      </div>

      <div className="field">
        <label>
          <span>Release fraction of stored volume</span>
          <span className="hint">{((sc.releaseFraction ?? 1) * 100).toFixed(0)} %</span>
        </label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={sc.releaseFraction ?? 1}
          onChange={(e) => patch({ releaseFraction: Number(e.target.value) })}
        />
        <div className="sub">Use &lt; 100 % if the tank would be isolated or only partly drained.</div>
      </div>

      {hydro && geom && (
        <div className="card" style={{ marginTop: 10 }}>
          <h3>Release hydrograph (computed)</h3>
          <div className="grid2">
            <div className="metric">
              <span className="label">Peak discharge Q</span>
              <span className="value">{fmtRate(hydro.peakQ)}</span>
            </div>
            <div className="metric">
              <span className="label">{hydro.stopReason === "empty" ? "Time to empty" : "Release duration"}</span>
              <span className="value">{fmtReleaseTime(hydro.emptyTimeS, hydro.stopReason)}</span>
            </div>
            <div className="metric">
              <span className="label">Volume released</span>
              <span className="value">{fmtVolume(hydro.totalVolumeM3)}</span>
            </div>
            <div className="metric">
              <span className="label">Peak Q at</span>
              <span className="value">{fmtTime(hydro.peakQTimeS)}</span>
            </div>
          </div>
          <LineChart series={qSeries} yLabel="Q (m³/s)" xLabel="time (s)" colour="#38bdf8" />
          <div style={{ color: "#93a4bd", fontSize: 11, marginTop: 4 }}>
            Q(t) = Cd · A · √(2 g h(t)) — computed per second with the falling head. Method:{" "}
            <b>{hydro.method}</b>, stop reason: <b>{hydro.stopReason.replace("_", " ")}</b>.
          </div>
        </div>
      )}
    </div>
  );
}

export function TerrainPanel() {
  const demSourceId = useApp((s) => s.demSourceId);
  const setDemSource = useApp((s) => s.setDemSource);
  const options = useApp((s) => s.options);
  const patchOptions = useApp((s) => s.patchOptions);
  const layers = useApp((s) => s.layers);
  const terrain3d = useApp((s) => s.terrain3d);
  const setTerrain3d = useApp((s) => s.setTerrain3d);
  const exaggeration = useApp((s) => s.terrainExaggeration);
  const setTerrainExaggeration = useApp((s) => s.setTerrainExaggeration);
  const toggleLayer = useApp((s) => s.toggleLayer);
  const setLayerOpacity = useApp((s) => s.setLayerOpacity);
  const meta = useApp((s) => s.demMetadata);

  return (
    <div className="panel-body">
      <div className="field">
        <label>
          <span>DEM source</span>
        </label>
        <select value={demSourceId} onChange={(e) => setDemSource(e.target.value)}>
          {DEM_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {meta && (
        <div className="card" style={{ marginBottom: 10 }}>
          <h3>DEM actually used</h3>
          <dl className="kv">
            <dt>Source</dt>
            <dd>{meta.label}</dd>
            <dt>Native resolution</dt>
            <dd>
              {meta.resolutionM} m nominal
              {meta.nativeCellSizeM ? ` · ${meta.nativeCellSizeM.toFixed(0)} m pixels on the ground` : ""}
            </dd>
            <dt>Analysis cell</dt>
            <dd>{meta.gridCellSizeM.toFixed(0)} m</dd>
            <dt>Vertical accuracy</dt>
            <dd>{meta.verticalAccuracyM !== null ? `±${meta.verticalAccuracyM} m` : "not stated"}</dd>
            <dt>Surface model</dt>
            <dd>{meta.surfaceModel ? "DSM (includes buildings/vegetation)" : "DTM / unknown"}</dd>
            <dt>Elevation range</dt>
            <dd>
              {meta.minZM.toFixed(1)} – {meta.maxZM.toFixed(1)} m
            </dd>
            <dt>No-data</dt>
            <dd>{(meta.nodataFraction * 100).toFixed(1)} %</dd>
          </dl>
          <div style={{ color: "#93a4bd", fontSize: 11, marginTop: 6 }}>
            {meta.attribution}
            <br />
            {meta.licence}
          </div>
        </div>
      )}

      <Num
        label="Analysis cell size"
        unit="m"
        value={options.cellSizeM ?? 12}
        step={1}
        min={5}
        max={60}
        onChange={(v) => patchOptions({ cellSizeM: v })}
        hint="coarsened if too many cells"
      />
      <Num
        label="Cell budget"
        value={options.maxCells}
        step={50000}
        min={50000}
        max={2000000}
        onChange={(v) => patchOptions({ maxCells: v })}
        hint="auto-coarsens beyond this"
      />
      <Num
        label="Reporting depth threshold"
        unit="m"
        value={options.reportingDepthM}
        step={0.001}
        min={0.001}
        onChange={(v) => patchOptions({ reportingDepthM: v })}
        hint="counted as affected"
      />
      <div className="field">
        <label>
          <span>
            Routing duration cap <span className="hint">hours</span>
          </span>
          <span className="hint">
            How long the flood is routed after the breach opens. Longer caps let the flow
            reach further but cost compute time; the run stops early once the release ends
            and the water has drained.
          </span>
        </label>
        <input
          type="number"
          min={0.25}
          max={12}
          step={0.5}
          value={Math.round((options.maxDurationS / 3600) * 100) / 100}
          onChange={(e) => patchOptions({ maxDurationS: Math.max(900, Number(e.target.value) * 3600) })}
        />
      </div>

      <div className="field">
        <label>
          <span>Manning roughness n</span>
        </label>
        <select value={options.manningN} onChange={(e) => patchOptions({ manningN: Number(e.target.value) })}>
          {MANNING_PRESETS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <Num
        label="Infiltration / surface loss"
        unit="mm/hr"
        value={options.infiltrationMmPerHr}
        step={1}
        min={0}
        max={200}
        onChange={(v) => patchOptions({ infiltrationMmPerHr: v })}
        hint="0 = impervious"
      />

      <label className="chk">
        <input type="checkbox" checked={options.smoothDem} onChange={(e) => patchOptions({ smoothDem: e.target.checked })} />
        <span>Smooth the DEM (3×3, removes single-cell spikes)</span>
      </label>

      <div className="field">
        <label>
          <span>
            Domain radius <span className="hint">km</span>
          </span>
          <span className="hint">
            How far downstream the flood is routed. Blank = automatic (scaled from the
            stored volume). Everything outside the radius is not modelled.
          </span>
        </label>
        <input
          type="number"
          min={0.3}
          max={20}
          step={0.5}
          placeholder="auto"
          value={options.domainRadiusM ? options.domainRadiusM / 1000 : ""}
          onChange={(e) => {
            const km = Number(e.target.value);
            patchOptions({ domainRadiusM: Number.isFinite(km) && km > 0 ? km * 1000 : undefined });
          }}
        />
      </div>

      <label className="chk">
        <input type="checkbox" checked={terrain3d} onChange={(e) => setTerrain3d(e.target.checked)} />
        <span>3-D terrain (drag with Ctrl to pitch; raster overlays stay draped)</span>
      </label>
      {terrain3d && (
        <div className="field">
          <label>
            <span>
              Vertical exaggeration <span className="hint">×</span>
            </span>
            <span className="hint">Exaggeration makes slopes readable; it does not change the model.</span>
          </label>
          <input
            type="range"
            min={1}
            max={4}
            step={0.1}
            value={exaggeration}
            onChange={(e) => setTerrainExaggeration(Number(e.target.value))}
          />
        </div>
      )}

      <h3 style={{ marginTop: 14, fontSize: 11, letterSpacing: 0.7, color: "#93a4bd", textTransform: "uppercase" }}>
        Analysis layers
      </h3>
      {layers.map((l) => (
        <label className="chk" key={l.id}>
          <input type="checkbox" checked={l.visible} onChange={() => toggleLayer(l.id)} />
          <span>{l.label}</span>
          <input
            className="opacity"
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={l.opacity}
            onChange={(e) => setLayerOpacity(l.id, Number(e.target.value))}
            title="Opacity"
          />
        </label>
      ))}
      <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => patchOptions({ ...DEFAULT_OPTIONS })}>
        Reset advanced settings
      </button>
    </div>
  );
}

export function ResultsPanel() {
  const result = useApp((s) => s.result);
  const exposure = useApp((s) => s.exposure);
  const osmAssets = useApp((s) => s.osmAssets);
  const exposureLoading = useApp((s) => s.exposureLoading);
  const frameStats = result?.frameStats ?? [];
  const [tab, setTab] = useState<"summary" | "exposure" | "balance" | "assumptions">("summary");

  if (!result) {
    return (
      <div className="panel-body">
        <div className="banner info">
          No simulation yet. Place a tank, choose a scenario, then press <b>Run simulation</b>.
        </div>
        <div className="sub" style={{ marginTop: 8, color: "#93a4bd" }}>
          The model computes the release hydrograph from the tank geometry, then routes that water over the real
          terrain with a 2-D shallow-flow solver. Nothing here is a buffer or a circle.
        </div>
      </div>
    );
  }

  const s = result.stats;
  const m = result.mass;

  return (
    <div className="panel-body">
      <div className="seg" style={{ marginBottom: 10, width: "100%" }}>
        {(["summary", "exposure", "balance", "assumptions"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} style={{ flex: 1, padding: "5px 2px", fontSize: 11 }}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <>
          <div className="grid2">
            <div className="metric">
              <span className="label">Volume released</span>
              <span className="value">{fmtVolume(m.releasedM3)}</span>
            </div>
            <div className="metric">
              <span className="label">Peak discharge</span>
              <span className="value">{fmtRate(result.hydro.peakQ)}</span>
            </div>
            <div className="metric">
              <span className="label">Affected area</span>
              <span className="value">{fmtArea(s.affectedAreaM2)}</span>
            </div>
            <div className="metric">
              <span className="label">Max modelled depth</span>
              <span className="value">{fmtDepth(s.maxDepthM)}</span>
            </div>
            <div className="metric">
              <span className="label">Peak velocity</span>
              <span className="value">{s.maxVelocityMs.toFixed(2)} m/s</span>
            </div>
            <div className="metric">
              <span className="label">
                {result.hydro.stopReason === "empty" ? "Time to empty" : "Release duration"}
              </span>
              <span className="value">{fmtReleaseTime(result.hydro.emptyTimeS, result.hydro.stopReason)}</span>
            </div>
            <div className="metric">
              <span className="label">Max extent from tank</span>
              <span className="value">{fmtLength(s.maxExtentDistanceM)}</span>
            </div>
            <div className="metric">
              <span className="label">Solver time</span>
              <span className="value">{(result.computeMs / 1000).toFixed(1)} s</span>
            </div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <h3>Depth classes (max over the event)</h3>
            {result.classes.map((c) => {
              if (c.areaM2 <= 0) return null;
              const total = Math.max(1, s.affectedAreaM2);
              return (
                <div key={c.id} className="swatch" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                  <i style={{ width: 14, height: 10, borderRadius: 2, background: c.colour, display: "inline-block" }} />
                  <span>{c.label}</span>
                  <span style={{ marginLeft: "auto", color: "#93a4bd", fontVariantNumeric: "tabular-nums" }}>
                    {fmtArea(c.areaM2)} ({((c.areaM2 / total) * 100).toFixed(0)} %)
                  </span>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <h3>Wet area over time</h3>
            <LineChart
              series={frameStats.map((f) => ({ x: f.t, y: f.wetAreaM2 / 10000 }))}
              yLabel="ha"
              xLabel="time (s)"
              colour="#34d399"
              fill="rgba(52,211,153,0.16)"
            />
            <h3 style={{ marginTop: 8 }}>Peak depth over time</h3>
            <Histogram values={frameStats.map((f) => f.maxDepthM)} maxValue={Math.max(0.1, s.maxDepthM)} colour="#38bdf8" />
          </div>
        </>
      )}

      {tab === "exposure" && (
        <>
          {exposureLoading && <div className="banner info">Fetching buildings and roads from OpenStreetMap…</div>}
          {osmAssets?.error && <div className="banner warn">{osmAssets.error}</div>}
          {!osmAssets && !exposureLoading && (
            <div className="banner info">
              Exposure was not assessed. Use <b>Assess exposure</b> in the results panel to query OSM buildings and
              roads for this domain.
            </div>
          )}
          {exposure && (
            <>
              <div className="grid2">
                <div className="metric">
                  <span className="label">Buildings exposed</span>
                  <span className="value">{exposure.totals.buildingCount.toLocaleString()}</span>
                </div>
                <div className="metric">
                  <span className="label">Road length exposed</span>
                  <span className="value">{fmtLength(exposure.totals.roadAffectedM)}</span>
                </div>
                <div className="metric">
                  <span className="label">of which ≥ 0.3 m deep</span>
                  <span className="value">{exposure.buildings.filter((b) => b.maxDepthM >= 0.3).length}</span>
                </div>
                <div className="metric">
                  <span className="label">of which ≥ 1.0 m deep</span>
                  <span className="value">{exposure.buildings.filter((b) => b.maxDepthM >= 1).length}</span>
                </div>
              </div>
              <div className="card" style={{ marginTop: 10 }}>
                <h3>Deepest exposed buildings</h3>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: "#93a4bd", textAlign: "left" }}>
                      <th style={{ padding: "2px 0" }}>Asset</th>
                      <th style={{ textAlign: "right" }}>Depth</th>
                      <th style={{ textAlign: "right" }}>Arrival</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...exposure.buildings]
                      .sort((a, b) => b.maxDepthM - a.maxDepthM)
                      .slice(0, 12)
                      .map((b) => (
                        <tr key={b.id}>
                          <td style={{ padding: "1px 0" }}>{b.name || b.kind || b.id}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtDepth(b.maxDepthM)}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {b.arrivalTimeS >= 0 ? fmtTime(b.arrivalTimeS) : "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="banner warn" style={{ marginTop: 10 }}>
                {exposure.notes.join(" ")}
              </div>
            </>
          )}
        </>
      )}

      {tab === "balance" && (
        <>
          <div className={m.ok ? "banner good" : "banner bad"}>
            <b>Mass balance {m.ok ? "closes" : "does NOT close"}</b> — released = stored + outflow + infiltration,
            closing error {m.errorPercent.toFixed(2)} % (tolerance 1.0 %).
          </div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Released by the tank</dt>
            <dd>{fmtVolume(m.releasedM3)}</dd>
            <dt>Still on the terrain</dt>
            <dd>{fmtVolume(m.wetM3)}</dd>
            <dt>Left the domain (outflow)</dt>
            <dd>{fmtVolume(m.outflowM3)}</dd>
            <dt>Infiltrated / abstracted</dt>
            <dd>{fmtVolume(m.infiltrationM3)}</dd>
            <dt>Left in the tank</dt>
            <dd>{fmtVolume(m.tankResidualM3)}</dd>
            <dt>Closing error</dt>
            <dd>
              {m.errorM3 >= 0 ? "+" : ""}
              {m.errorM3.toFixed(3)} m³ ({m.errorPercent.toFixed(3)} %)
            </dd>
          </dl>
          <div className="banner info" style={{ marginTop: 10 }}>
            A positive error means the model stored slightly more water than it released (numerical rounding in the
            outflow limiter). Anything beyond ±1 % indicates a solver problem and should not be used.
          </div>
        </>
      )}

      {tab === "assumptions" && (
        <div style={{ fontSize: 12, color: "#cbd5e1" }}>
          <h3 style={{ color: "#e6edf7", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.7 }}>What the model does</h3>
          <ul style={{ paddingLeft: 16, margin: "4px 0 12px" }}>
            <li>
              Release: orifice <b>Q = Cd·A·√(2gh)</b> with falling head, or a broad-crested weir{" "}
              <b>Q = 1.7·b·H^1.5</b> for a breach.
            </li>
            <li>
              Flow: 2-D shallow-water equations in inertial form (Bates et al. 2010) on a {" "}
              {result.grid.dx.toFixed(0)} m grid, CFL-controlled time step, Manning friction{" "}
              {result.options.manningN}.
            </li>
            <li>Infiltration: constant rate {result.options.infiltrationMmPerHr} mm/hr.</li>
            <li>
              Domain: {((result.grid.nx * result.grid.ny) / 1e6).toFixed(2)} M cells, radius{" "}
              {fmtLength((result.grid.nx * result.grid.dx) / 2)}. All four edges are open outfalls.
            </li>
            <li>Hazard classes use depth × velocity (DEFRA/EA style), thresholds shown in the legend.</li>
          </ul>
          <h3 style={{ color: "#e6edf7", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.7 }}>What it does NOT do</h3>
          <ul style={{ paddingLeft: 16, margin: "4px 0 12px" }}>
            <li>No advection/momentum transport — no hydraulic jump, no surge front, no shock capturing.</li>
            <li>No vertical jet impact: the release is applied as a surface inflow over the footprint.</li>
            <li>No storm-drain network, culverts, walls or building blockage (unless a mask is supplied).</li>
            <li>No sediment, erosion, evaporation or soil physics.</li>
            <li>DEM vertical error is NOT propagated — treat absolute depths as ±the DEM accuracy.</li>
            <li>Uniform roughness; no land-cover variation.</li>
          </ul>
          <h3 style={{ color: "#e6edf7", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.7 }}>Reproducibility</h3>
          <dl className="kv">
            <dt>Run hash</dt>
            <dd style={{ fontFamily: "ui-monospace, monospace" }}>{result.hash}</dd>
            <dt>Solver</dt>
            <dd>TankBreach v0.1 · inertial SWE</dd>
          </dl>
          <div className="banner warn" style={{ marginTop: 10 }}>
            Screening and awareness only. A licensed hydraulic engineer and a field survey must confirm any
            real-world conclusion.
          </div>
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          {result.warnings.map((w, i) => (
            <div key={i} style={{ marginBottom: 3 }}>
              • {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { DEPTH_CLASSES, HAZARD_CLASSES, G };

/**
 * Impact assessment panel: the user-defined boundary, the three damage bands and the
 * direction-of-flow summary, plus the vector exports.
 *
 * Changing the boundary recomputes the analysis from the finished rasters — the solver is
 * never re-run, which is what makes the input feel instantaneous even on a 700 k-cell run.
 */
export function ImpactPanel() {
  const result = useApp((s) => s.result);
  const layers = useApp((s) => s.layers);
  const toggleLayer = useApp((s) => s.toggleLayer);

  if (!result) {
    return (
      <div className="panel-body">
        <div className="banner info">
          Run a simulation first. The impact assessment is computed from the finished depth and velocity fields.
        </div>
      </div>
    );
  }

  const maxBand = Math.max(1e-9, ...result.damageBands.map((b) => b.areaM2));
  const totalWetArea = result.stats.affectedAreaM2;

  return (
    <div className="panel-body">
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Damage Assessment</h3>
          <button
            className="btn sm ghost"
            onClick={() => window.dispatchEvent(new CustomEvent("tb:fitbands"))}
            title="Zoom map to the flood extent"
          >
            Zoom Extent
          </button>
        </div>
        <div className="sub" style={{ marginTop: 8, marginBottom: 8 }}>
          The map shade is a continuous gradient of the damage score across the natural flood extent; the three bands are the
          class boundaries drawn on top of it.{" "}
          {result.damageMethod === "hazard_depth"
            ? "Classified on depth × velocity, with a 1.5 m depth override."
            : "Classified on depth only — the modelled flow is too slow for velocity to change the class."}{" "}
          Total affected: {fmtArea(totalWetArea)} ({result.stats.wetCellCount.toLocaleString()} cells).
        </div>
        {result.damageBands.map((b) => {
          const pctOfWet = totalWetArea > 0 ? (b.areaM2 / totalWetArea) * 100 : 0;
          return (
            <div key={b.id} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <i style={{ width: 14, height: 10, borderRadius: 2, background: b.colour, display: "inline-block" }} />
                <b>{b.label}</b>
                <span style={{ marginLeft: "auto", color: "#93a4bd", fontVariantNumeric: "tabular-nums" }}>
                  {fmtArea(b.areaM2)} · {pctOfWet.toFixed(1)} % of affected area
                </span>
              </div>
              <div style={{ height: 5, background: "#16202f", borderRadius: 3, marginTop: 3, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${(b.areaM2 / maxBand) * 100}%`,
                    height: "100%",
                    background: b.colour,
                    opacity: 0.85,
                  }}
                />
              </div>
            </div>
          );
        })}
        <div className="sub" style={{ marginTop: 6 }}>
          {result.damageBands.reduce((n, b) => n + b.cellCount, 0).toLocaleString()} cells classified ·{" "}
          {result.grid.dx.toFixed(0)} m cells
        </div>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>Map layers</h3>
        {(["damage"] as const).map((id) => {
          const l = layers.find((x) => x.id === id);
          return (
            <label key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
              <input type="checkbox" checked={!!l?.visible} onChange={() => toggleLayer(id)} />
              {l?.label ?? id}
            </label>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>Municipal Deliverables &amp; Exports</h3>
        <div className="grid2" style={{ gap: 6, marginBottom: 8 }}>
          <button className="btn sm primary" onClick={() => void doVectorExport("pdf")}>
            📄 PDF Report
          </button>
          <button className="btn sm primary" onClick={() => void doVectorExport("png")}>
            🗺️ ArcGIS Pro PNG Map
          </button>
        </div>
        <div className="grid2" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => void doVectorExport("damageKmz")}>
            KMZ (Google Earth)
          </button>
          <button className="btn sm" onClick={() => void doVectorExport("damageShp")}>
            SHP (Shapefile Zip)
          </button>
          <button className="btn sm" onClick={() => void doVectorExport("damageGeojson")}>
            GeoJSON Vectors
          </button>
          <button className="btn sm" onClick={() => void doVectorExport("damageDxf")}>
            DXF (AutoCAD)
          </button>
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          Publication-grade PDF report and ArcGIS map sheet, plus KMZ with embedded hazard legend,
          shapefiles (<code>damage_bands</code>, <code>flow_direction</code>, <code>boundary</code>), and DXF CAD layers.
        </div>
      </div>
    </div>
  );
}

/** Filled in by App on mount so the panel can trigger downloads without prop-drilling. */
export let doVectorExport: (
  kind: "damageGeojson" | "damageKmz" | "damageShp" | "damageDxf" | "pdf" | "png",
) => Promise<void> = async () => {};
export function setVectorExportHandler(fn: typeof doVectorExport) {
  doVectorExport = fn;
}
