import { useEffect, useRef } from "react";
import { useApp } from "../store";
import { fmtArea, fmtDepth, fmtRate, fmtVolume } from "../format";
import { PRESETS } from "../presets";
import type { SimulationResult } from "../engine/types";

/**
 * Signed divergence ramp for the difference map: blue = scenario B deeper, red = A deeper.
 * Colour-blind safe (blue/orange-red axis carries a lightness gradient as well as hue).
 */
export const DIFF_RAMP: { from: number; to: number; colour: [number, number, number] }[] = [
  { from: -Infinity, to: -1.0, colour: [49, 54, 149] },
  { from: -1.0, to: -0.5, colour: [69, 117, 180] },
  { from: -0.5, to: -0.2, colour: [116, 173, 209] },
  { from: -0.2, to: -0.05, colour: [171, 207, 230] },
  { from: -0.05, to: 0.05, colour: [247, 246, 240] },
  { from: 0.05, to: 0.2, colour: [253, 208, 162] },
  { from: 0.2, to: 0.5, colour: [244, 158, 110] },
  { from: 0.5, to: 1.0, colour: [215, 88, 74] },
  { from: 1.0, to: Infinity, colour: [140, 39, 44] },
];

/** Draws B (positive) minus A (negative) max-depth difference on a canvas. */
export function DiffCanvas({ a, b, height = 260 }: { a: SimulationResult; b: SimulationResult; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const nx = a.grid.nx;
    const ny = a.grid.ny;
    cv.width = nx;
    cv.height = ny;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(nx, ny);
    for (let r = 0; r < ny; r++) {
      // Image rows are top-down; grid rows run south -> north.
      const gr = ny - 1 - r;
      for (let c = 0; c < nx; c++) {
        const i = gr * nx + c;
        const da = a.maxDepth[i];
        const db = b.maxDepth[i];
        const d = (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);
        const band = DIFF_RAMP.find((x) => d >= x.from && d < x.to) ?? DIFF_RAMP[4];
        const dry = (Number.isFinite(da) ? da : 0) < 0.005 && (Number.isFinite(db) ? db : 0) < 0.005;
        const o = (r * nx + c) * 4;
        img.data[o] = band.colour[0];
        img.data[o + 1] = band.colour[1];
        img.data[o + 2] = band.colour[2];
        img.data[o + 3] = dry ? 0 : 235;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [a, b]);

  return (
    <div>
      <canvas
        ref={ref}
        style={{ width: "100%", height, imageRendering: "pixelated", borderRadius: 8, background: "#0b1220", border: "1px solid var(--line)" }}
        aria-label="Difference in modelled depth between the two scenarios"
      />
      <div className="row" style={{ gap: 10, marginTop: 6, fontSize: 11, color: "var(--muted)", flexWrap: "wrap" }}>
        <span>◀ deeper in B</span>
        <span>equal</span>
        <span>deeper in A ▶</span>
      </div>
    </div>
  );
}

const MODES: { id: "leak" | "partial_breach" | "catastrophic_breach" | "overtopping"; label: string }[] = [
  { id: "leak", label: "Leak" },
  { id: "partial_breach", label: "Partial breach" },
  { id: "catastrophic_breach", label: "Catastrophic breach" },
  { id: "overtopping", label: "Overtopping" },
];

/**
 * Compare mode: 2–4 scenarios routed in sequence through the same worker, then shown side by
 * side with a difference map between the first two.
 */
export default function ComparePanel() {
  const compareRuns = useApp((s) => s.compareRuns);
  const compareResults = useApp((s) => s.compareResults);
  const compareRunning = useApp((s) => s.compareRunning);
  const scenario = useApp((s) => s.scenario);
  const patchCompareRun = useApp((s) => s.patchCompareRun);
  const addCompareRun = useApp((s) => s.addCompareRun);
  const removeCompareRun = useApp((s) => s.removeCompareRun);
  const setMunicipalCompareRuns = useApp((s) => s.setMunicipalCompareRuns);
  const runCompare = useApp((s) => s.runCompare);
  const tank = useApp((s) => s.tank);
  const dem = useApp((s) => s.demMetadata);

  const results = compareResults;
  if (!tank && results.length === 0) {
    return (
      <div className="panel-body">
        <div className="banner warn">Place a tank on the map first (Tank tab), then compare scenarios.</div>
      </div>
    );
  }
  return (
    <div className="panel-body">
      <div
        style={{
          background: "linear-gradient(135deg, rgba(30, 58, 138, 0.25) 0%, rgba(15, 23, 42, 0.4) 100%)",
          border: "1px solid rgba(56, 189, 248, 0.35)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 12, color: "#38bdf8", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
          <span>🏛️</span> Municipal Scenario Setup
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8, lineHeight: 1.4 }}>
          Evaluate both municipal disaster cases: <b>Case 1 (Wall Puncture Leak, 150 mm)</b> vs <b>Case 2 (Catastrophic Wall Breach, 8 m)</b> over the 1.0 km² assessment area.
        </div>
        <button
          className="btn sm primary"
          style={{ width: "100%", fontWeight: 600 }}
          onClick={() => {
            setMunicipalCompareRuns();
          }}
        >
          Load Case 1 vs Case 2 Scenarios
        </button>
      </div>

      <div className="banner info" style={{ marginBottom: 10 }}>
        Run the same tank through 2–4 release scenarios and compare them. Each scenario is a
        full re-run of the model — nothing here is interpolated or estimated.
      </div>

      {compareRuns.map((run, i) => (
        <div className="field" key={run.id} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
          <label>
            <span>
              Scenario {String.fromCharCode(65 + i)} <span className="hint">{run.label}</span>
            </span>
          </label>
          <div className="row" style={{ gap: 6 }}>
            <select
              value={run.scenario.mode}
              onChange={(e) => patchCompareRun(run.id, { scenario: { ...run.scenario, mode: e.target.value as never } })}
              style={{ flex: 1 }}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {compareRuns.length > 2 && (
              <button className="btn sm ghost" onClick={() => removeCompareRun(run.id)} title="Remove">
                ×
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              type="text"
              value={run.label}
              onChange={(e) => patchCompareRun(run.id, { label: e.target.value })}
              placeholder="label"
              style={{ flex: 1 }}
              aria-label={`Label for scenario ${String.fromCharCode(65 + i)}`}
            />
            <input
              type="number"
              value={run.scenario.breachWidthM ?? 8}
              min={1}
              max={60}
              step={1}
              title="Breach / opening width, m"
              onChange={(e) =>
                patchCompareRun(run.id, { scenario: { ...run.scenario, breachWidthM: Number(e.target.value) } })
              }
              style={{ width: 74 }}
              aria-label="Opening width, metres"
            />
          </div>
        </div>
      ))}

      <div className="row" style={{ gap: 6, margin: "10px 0" }}>
        <button className="btn sm" onClick={addCompareRun} disabled={compareRuns.length >= 4}>
          + Add scenario
        </button>
        <button className="btn sm" onClick={() => patchCompareRun(compareRuns[compareRuns.length - 1].id, { scenario: { ...scenario } })}>
          Copy current
        </button>
      </div>

      <button className="btn primary" style={{ width: "100%" }} onClick={runCompare} disabled={compareRunning}>
        {compareRunning ? "Running…" : `Run ${compareRuns.length} scenarios`}
      </button>

      <div className="hint" style={{ marginTop: 8 }}>
        Presets: {PRESETS.map((p) => p.label).join(" · ")}
      </div>

      {results.length >= 2 && (
        <>
          <h3 style={{ margin: "16px 0 8px", fontSize: 11, letterSpacing: 0.7, color: "#93a4bd", textTransform: "uppercase" }}>
            Side by side
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="cmp" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "start", color: "var(--muted)", fontWeight: 600, padding: "4px 6px" }} />
                  {results.map((r) => (
                    <th key={r.label} style={{ textAlign: "end", padding: "4px 6px", fontWeight: 700 }}>
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Released", (r: SimulationResult) => fmtVolume(r.mass.releasedM3)],
                  ["Peak Q", (r: SimulationResult) => fmtRate(r.hydro.peakQ)],
                  ["Affected area", (r: SimulationResult) => fmtArea(r.stats.affectedAreaM2)],
                  ["Inundated in 1.0 km²", (r: SimulationResult) => `${(r.stats.affectedAreaM2 / 10000).toFixed(2)} ha (${((r.stats.affectedAreaM2 / 1e6) * 100).toFixed(1)}%)`],
                  ["Max depth", (r: SimulationResult) => fmtDepth(r.stats.maxDepthM)],
                  ["Peak velocity", (r: SimulationResult) => `${r.stats.maxVelocityMs.toFixed(2)} m/s`],
                  ["Max extent", (r: SimulationResult) => `${r.stats.maxExtentDistanceM.toFixed(0)} m`],
                  ["Flow direction", (r: SimulationResult) => `${r.flow.dominantLabel} (${r.flow.dominantDirDeg.toFixed(0)}°)`],
                  ["Municipal response", (r: SimulationResult) => r.hydro.method === "orifice" ? "Valve isolation / storm drain diversion" : "Immediate siren / downstream evacuation"],
                  ["Mass error", (r: SimulationResult) => `${r.mass.errorPercent.toFixed(2)} %`],
                ].map(([label, fn]) => (
                  <tr key={label as string}>
                    <td style={{ color: "var(--muted)", padding: "3px 6px" }}>{label as string}</td>
                    {results.map((r) => (
                      <td key={r.label} style={{ textAlign: "end", padding: "3px 6px", fontVariantNumeric: "tabular-nums" }}>
                        {(fn as (x: SimulationResult) => string)(r.result)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ margin: "16px 0 8px", fontSize: 11, letterSpacing: 0.7, color: "#93a4bd", textTransform: "uppercase" }}>
            Difference map — {results[1].label} minus {results[0].label}
          </h3>
          <DiffCanvas a={results[0].result} b={results[1].result} />
          <div className="hint" style={{ marginTop: 6 }}>
            Cells where both scenarios stay dry are transparent. The comparison uses identical
            terrain, grid and solver settings, so differences come only from the release.
          </div>
          <button
            className="btn"
            style={{ width: "100%", marginTop: 10 }}
            onClick={async () => {
              const { buildComparePdf } = await import("../export/pdf");
              if (!tank) return;
              const blob = await buildComparePdf({ tank, dem, runs: results });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "tankbreach_comparison.pdf";
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            }}
          >
            Download comparison PDF
          </button>
        </>
      )}
    </div>
  );
}
