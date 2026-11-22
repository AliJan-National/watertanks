import { create } from "zustand";
import type {
  DemMetadata,
  ScenarioSpec,
  SimulationOptions,
  SimulationResult,
  TankSpec,
} from "./engine/types";
import type { OsmAssets } from "./providers/basemaps";
import type { ExposureResult } from "./engine/exposure";
import { DEFAULT_OPTIONS } from "./presets";

export type LayerId =
  | "maxDepth"
  | "depthNow"
  | "arrival"
  | "velocity"
  | "hazard"
  | "extent"
  | "flowPath"
  | "damage"
  | "flowArrows"
  | "flowNetwork"
  | "impactBoundary"
  | "hillshade"
  | "contours"
  | "buildings"
  | "roads"
  | "tankFootprint";

export interface LayerState {
  id: LayerId;
  label: string;
  visible: boolean;
  opacity: number;
}

export const DEFAULT_LAYERS: LayerState[] = [
  { id: "maxDepth", label: "Max depth", visible: false, opacity: 0.78 },
  { id: "depthNow", label: "Depth at time t", visible: false, opacity: 0.9 },
  { id: "arrival", label: "Arrival time", visible: false, opacity: 0.8 },
  { id: "velocity", label: "Peak velocity", visible: false, opacity: 0.8 },
  { id: "hazard", label: "Hazard class (d × v)", visible: false, opacity: 0.8 },
  { id: "extent", label: "Inundation extent", visible: true, opacity: 1 },
  { id: "damage", label: "Affected areas & hazard bands", visible: true, opacity: 0.9 },
  { id: "hillshade", label: "Terrain hillshade", visible: false, opacity: 0.55 },
  { id: "contours", label: "Contours", visible: false, opacity: 0.5 },
  { id: "buildings", label: "Exposed buildings", visible: true, opacity: 1 },
  { id: "roads", label: "Exposed roads", visible: true, opacity: 1 },
  { id: "tankFootprint", label: "Tank footprint", visible: true, opacity: 1 },
];

export type RunState = "idle" | "running" | "done" | "error";

export interface CompareRun {
  id: string;
  label: string;
  scenario: ScenarioSpec;
}

export interface CompareResult {
  label: string;
  result: SimulationResult;
}

export interface AppState {
  // ---- map / location
  basemap: string;
  layers: LayerState[];

  // ---- inputs
  tank: TankSpec | null;
  scenario: ScenarioSpec;
  options: SimulationOptions;
  demSourceId: string;
  placingTank: boolean;
  demElevationAtTank: number | null;
  demProbeBusy: boolean;

  // ---- run state
  runState: RunState;
  progress: { fraction: number; stage: string };
  error: string | null;
  result: SimulationResult | null;
  demMetadata: DemMetadata | null;
  frameIndex: number;
  playing: boolean;
  playbackSpeed: number;

  // ---- exposure
  osmAssets: OsmAssets | null;
  exposure: ExposureResult | null;
  exposureLoading: boolean;

  // ---- compare mode
  compareRuns: CompareRun[];
  compareResults: CompareResult[];
  compareRunning: boolean;

  // ---- ui
  sidebarTab: "tank" | "scenario" | "terrain" | "results" | "impact" | "compare";
  sidebarOpen: boolean;
  showLegend: boolean;
  showAssumptions: boolean;
  language: "en" | "ar";
  units: "metric" | "imperial";
  terrain3d: boolean;
  terrainExaggeration: number;
  /** Size of the square assessment boundary around the tank, km². */
  impactAreaKm2: number;
  /** True while the damage/flow analysis is being recomputed for a new boundary. */
  impactBusy: boolean;

  // ---- actions
  setBasemap: (id: string) => void;
  toggleLayer: (id: LayerId) => void;
  setLayerOpacity: (id: LayerId, opacity: number) => void;
  setTank: (t: TankSpec | null) => void;
  patchTank: (patch: Partial<TankSpec>) => void;
  patchScenario: (patch: Partial<ScenarioSpec>) => void;
  patchOptions: (patch: Partial<SimulationOptions>) => void;
  setDemSource: (id: string) => void;
  setPlacingTank: (v: boolean) => void;
  setDemElevationAtTank: (z: number | null) => void;
  setDemProbeBusy: (b: boolean) => void;
  setRunState: (s: RunState) => void;
  setProgress: (fraction: number, stage: string) => void;
  setError: (e: string | null) => void;
  setResult: (r: SimulationResult | null, meta?: DemMetadata | null) => void;
  setFrameIndex: (i: number) => void;
  setPlaying: (p: boolean) => void;
  setPlaybackSpeed: (s: number) => void;
  setOsmAssets: (a: OsmAssets | null) => void;
  setExposure: (e: ExposureResult | null) => void;
  setExposureLoading: (v: boolean) => void;
  setSidebarTab: (t: AppState["sidebarTab"]) => void;
  setSidebarOpen: (v: boolean) => void;
  setShowLegend: (v: boolean) => void;
  setShowAssumptions: (v: boolean) => void;
  setLanguage: (l: "en" | "ar") => void;
  setUnits: (u: "metric" | "imperial") => void;
  setTerrain3d: (v: boolean) => void;
  setTerrainExaggeration: (v: number) => void;
  setImpactAreaKm2: (v: number) => void;
  setImpactBusy: (v: boolean) => void;
  /** Replaces the damage bands + flow field without touching the solver output. */
  applyImpact: (patch: {
    damageClass: Uint8Array;
    damageScore: Uint8Array;
    damageBands: SimulationResult["damageBands"];
    damageMethod: SimulationResult["damageMethod"];
    flow: SimulationResult["flow"];
    impactAreaKm2: number;
  }) => void;
  /** Wholesale replacement of the editable inputs (used by save/load and permalinks). */
  loadInputs: (p: { tank?: TankSpec | null; scenario?: ScenarioSpec; options?: SimulationOptions }) => void;
  addCompareRun: () => void;
  removeCompareRun: (id: string) => void;
  patchCompareRun: (id: string, patch: Partial<CompareRun>) => void;
  setMunicipalCompareRuns: () => void;
  setCompareResults: (r: CompareResult[], running: boolean) => void;
  runCompare: () => void;
  /** Filled in by App, which owns the map and the worker. */
  requestGeolocation: () => void;
  flyTo: ((lng: number, lat: number, zoom?: number) => void) | null;
}

const DEFAULT_SCENARIO: ScenarioSpec = {
  mode: "leak",
  holeShape: "circular",
  holeDiameterM: 0.1,
  holeElevationAboveBaseM: 0,
  dischargeCoefficientCd: 0.61,
  breachWidthM: 8,
  breachDevelopmentSeconds: 0,
};

export const useApp = create<AppState>((set, get) => ({
  basemap: "satellite",
  layers: DEFAULT_LAYERS.map((l) => ({ ...l })),

  tank: null,
  scenario: { ...DEFAULT_SCENARIO },
  options: { ...DEFAULT_OPTIONS },
  demSourceId: "copernicus_glo30",
  placingTank: false,
  demElevationAtTank: null,
  demProbeBusy: false,

  runState: "idle",
  progress: { fraction: 0, stage: "" },
  error: null,
  result: null,
  demMetadata: null,
  frameIndex: 0,
  playing: false,
  playbackSpeed: 8,

  osmAssets: null,
  exposure: null,
  exposureLoading: false,

  compareRuns: [
    {
      id: "A",
      label: "Pinhole leak",
      scenario: {
        mode: "leak",
        holeShape: "circular",
        holeDiameterM: 0.1,
        holeElevationAboveBaseM: 0,
        dischargeCoefficientCd: 0.61,
        breachWidthM: 8,
        breachDevelopmentSeconds: 0,
      },
    },
    {
      id: "B",
      label: "Catastrophic breach",
      scenario: {
        mode: "catastrophic_breach",
        holeShape: "circular",
        holeDiameterM: 0.1,
        holeElevationAboveBaseM: 0,
        dischargeCoefficientCd: 0.61,
        breachWidthM: 12,
        breachDevelopmentSeconds: 0,
      },
    },
  ],
  compareResults: [],
  compareRunning: false,

  sidebarTab: "tank",
  sidebarOpen: true,
  showLegend: true,
  showAssumptions: false,
  language: "en",
  units: "metric",
  terrain3d: false,
  terrainExaggeration: 1.6,
  impactAreaKm2: DEFAULT_OPTIONS.impactAreaKm2 ?? 0,
  impactBusy: false,

  setBasemap: (id) => set({ basemap: id }),
  toggleLayer: (id) =>
    set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)) })),
  setLayerOpacity: (id, opacity) =>
    set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, opacity } : l)) })),
  setTank: (t) => set({ tank: t }),
  patchTank: (patch) => set((s) => (s.tank ? { tank: { ...s.tank, ...patch } } : {})),
  patchScenario: (patch) => set((s) => ({ scenario: { ...s.scenario, ...patch } })),
  patchOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
  setDemSource: (id) => set({ demSourceId: id }),
  setPlacingTank: (v) => set({ placingTank: v }),
  setDemElevationAtTank: (z) => set({ demElevationAtTank: z }),
  setDemProbeBusy: (b) => set({ demProbeBusy: b }),
  setRunState: (s) => set({ runState: s }),
  setProgress: (fraction, stage) => set({ progress: { fraction, stage } }),
  setError: (e) => set({ error: e }),
  setResult: (r, meta) =>
    set((s) => ({
      result: r,
      demMetadata: meta !== undefined ? meta : s.demMetadata,
      frameIndex: r ? r.frames.length - 1 : 0,
      runState: r ? "done" : s.runState,
      playing: false,
    })),
  setFrameIndex: (i) => set({ frameIndex: i }),
  setPlaying: (p) => set({ playing: p }),
  setPlaybackSpeed: (s) => set({ playbackSpeed: s }),
  setOsmAssets: (a) => set({ osmAssets: a }),
  setExposure: (e) => set({ exposure: e }),
  setExposureLoading: (v) => set({ exposureLoading: v }),
  setSidebarTab: (t) => set({ sidebarTab: t }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setShowLegend: (v) => set({ showLegend: v }),
  setShowAssumptions: (v) => set({ showAssumptions: v }),
  setLanguage: (l) => set({ language: l }),
  setUnits: (u) => set({ units: u }),
  setTerrain3d: (v) => set({ terrain3d: v }),
  setTerrainExaggeration: (v) => set({ terrainExaggeration: v }),
  setImpactAreaKm2: (v) =>
    set((s) => ({ impactAreaKm2: v, options: { ...s.options, impactAreaKm2: v } })),
  setImpactBusy: (v) => set({ impactBusy: v }),
  applyImpact: (patch) =>
    set((s) => ({
      impactAreaKm2: patch.impactAreaKm2,
      options: { ...s.options, impactAreaKm2: patch.impactAreaKm2 },
      result: s.result
        ? {
            ...s.result,
            damageClass: patch.damageClass,
            damageScore: patch.damageScore,
            damageBands: patch.damageBands,
            damageMethod: patch.damageMethod,
            flow: patch.flow,
          }
        : s.result,
    })),
  addCompareRun: () =>
    set((s) => {
      if (s.compareRuns.length >= 4) return {};
      const id = String.fromCharCode(65 + s.compareRuns.length);
      return {
        compareRuns: [
          ...s.compareRuns,
          {
            id,
            label: `Scenario ${id}`,
            scenario: { ...s.compareRuns[s.compareRuns.length - 1].scenario, breachWidthM: (s.compareRuns[s.compareRuns.length - 1].scenario.breachWidthM ?? 8) + 4 },
          },
        ],
      };
    }),
  removeCompareRun: (id) => set((s) => ({ compareRuns: s.compareRuns.filter((r) => r.id !== id) })),
  patchCompareRun: (id, patch) =>
    set((s) => ({ compareRuns: s.compareRuns.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  setMunicipalCompareRuns: () =>
    set({
      compareRuns: [
        {
          id: "A",
          label: "Case 1: Wall Puncture Leak (150 mm)",
          scenario: {
            mode: "leak",
            holeShape: "circular",
            holeDiameterM: 0.15,
            holeElevationAboveBaseM: 0,
            dischargeCoefficientCd: 0.61,
            breachWidthM: 8,
            breachDevelopmentSeconds: 0,
          },
        },
        {
          id: "B",
          label: "Case 2: Catastrophic Breach (8 m collapse)",
          scenario: {
            mode: "catastrophic_breach",
            holeShape: "circular",
            holeDiameterM: 0.1,
            holeElevationAboveBaseM: 0,
            dischargeCoefficientCd: 0.61,
            breachWidthM: 8,
            breachDevelopmentSeconds: 0,
          },
        },
      ],
    }),
  setCompareResults: (compareResults, compareRunning) => set({ compareResults, compareRunning }),
  // The real implementations need the worker and the map; App swaps them in on mount.
  runCompare: async () => {},
  requestGeolocation: () => {},
  flyTo: null,
  loadInputs: (p) =>
    set((s) => ({
      tank: p.tank === undefined ? s.tank : p.tank,
      scenario: p.scenario ? { ...s.scenario, ...p.scenario } : s.scenario,
      options: p.options ? { ...s.options, ...p.options } : s.options,
      impactAreaKm2: (p.options?.impactAreaKm2 ?? s.impactAreaKm2),
    })),
}));
