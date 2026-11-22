/**
 * Scenario persistence: local save/load (localStorage), shareable permalink.
 *
 * Deliberately excludes results. A shared link re-runs the model on the recipient's machine,
 * so nobody can ever be shown a stale raster that no longer matches the inputs.
 */
import type { ScenarioSpec, SimulationOptions, TankSpec } from "./engine/types";

export interface ScenarioFile {
  app: "TankBreach";
  version: 1;
  savedUtc: string;
  tank: TankSpec | null;
  scenario: ScenarioSpec;
  options: SimulationOptions;
  demSourceId: string;
  layerVisibility?: Record<string, boolean>;
}

const KEY = "tankbreach.scenarios.v1";

export function readSaved(): Record<string, ScenarioFile> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, ScenarioFile>) : {};
  } catch {
    return {};
  }
}

export function writeSaved(name: string, file: ScenarioFile): void {
  const all = readSaved();
  all[name] = file;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota — saving is a convenience, never a requirement */
  }
}

export function deleteSaved(name: string): void {
  const all = readSaved();
  delete all[name];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Compact URL-safe encoding of the inputs (base64url of JSON). */
export function encodePermalink(file: ScenarioFile): string {
  const json = JSON.stringify({
    v: 1,
    t: file.tank,
    s: file.scenario,
    o: file.options,
    d: file.demSourceId,
    l: Object.fromEntries(Object.entries(file.layerVisibility ?? {}).filter(([, v]) => v)),
  });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodePermalink(hash: string): Partial<ScenarioFile> | null {
  try {
    const b64 = hash.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const raw = JSON.parse(json) as {
      v: number;
      t: TankSpec | null;
      s: ScenarioSpec;
      o: SimulationOptions;
      d?: string;
      l?: Record<string, boolean>;
    };
    if (raw.v !== 1) return null;
    return {
      tank: raw.t,
      scenario: raw.s,
      options: raw.o,
      demSourceId: raw.d,
      layerVisibility: raw.l,
    };
  } catch {
    return null;
  }
}

export function downloadJson(file: ScenarioFile, filename: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
