import type { ScenarioSpec, SimulationOptions, TankSpec } from "./engine/types";

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  tank: Omit<TankSpec, "location" | "baseElevationM"> & { baseElevationM?: number };
  scenario: ScenarioSpec;
}

export const DEFAULT_OPTIONS: SimulationOptions = {
  manningN: 0.05,
  infiltrationMmPerHr: 0,
  reportingDepthM: 0.005,
  maxDurationS: 6 * 3600,
  frameCount: 60,
  maxCells: 700_000,
  cellSizeM: 12,
  buildingsAsObstacles: false,
  smoothDem: true,
};

export const MANNING_PRESETS = [
  { value: 0.013, label: "Smooth concrete / asphalt (0.013)" },
  { value: 0.03, label: "Bare soil / gravel (0.030)" },
  { value: 0.05, label: "Mixed urban, some vegetation (0.050)" },
  { value: 0.08, label: "Dense urban, obstacles (0.080)" },
  { value: 0.12, label: "Scrub / orchard / rough pasture (0.120)" },
];

export const PRESETS: Preset[] = [
  {
    id: "rooftop",
    label: "Municipal rooftop tank",
    blurb: "500 m³, Ø10 m, 6.4 m wall — 100 mm bottom-hole leak",
    tank: {
      id: "preset-rooftop",
      name: "Rooftop tank",
      shape: "cylindrical",
      capacityM3: 500,
      diameterM: 10,
      wallHeightM: 6.4,
      waterHeadM: 6.4,
      fluid: "water",
    },
    scenario: {
      mode: "leak",
      holeShape: "circular",
      holeDiameterM: 0.1,
      holeElevationAboveBaseM: 0,
      dischargeCoefficientCd: 0.61,
    },
  },
  {
    id: "elevated",
    label: "Elevated neighbourhood tank",
    blurb: "2 000 m³, 25 m head — catastrophic 12 m breach",
    tank: {
      id: "preset-elevated",
      name: "Elevated tank",
      shape: "cylindrical",
      capacityM3: 2000,
      diameterM: 16,
      wallHeightM: 10,
      waterHeadM: 10,
      baseAboveGroundM: 25,
      fluid: "water",
    },
    scenario: {
      mode: "catastrophic_breach",
      holeShape: "circular",
      holeElevationAboveBaseM: 0,
      dischargeCoefficientCd: 0.61,
      breachWidthM: 12,
      breachDevelopmentSeconds: 60,
    },
  },
  {
    id: "farm",
    label: "Farm irrigation reservoir",
    blurb: "5 000 m³, 50 × 40 m, 3 m walls — overtopping + 250 mm hole",
    tank: {
      id: "preset-farm",
      name: "Irrigation reservoir",
      shape: "rectangular",
      capacityM3: 5000,
      lengthM: 50,
      widthM: 40,
      wallHeightM: 3,
      waterHeadM: 3.1,
      fluid: "water",
    },
    scenario: {
      mode: "overtopping",
      holeShape: "circular",
      holeDiameterM: 0.25,
      holeElevationAboveBaseM: 0.2,
      dischargeCoefficientCd: 0.61,
      breachWidthM: 20,
    },
  },
  {
    id: "brine",
    label: "Industrial brine tank",
    blurb: "300 m³ — 50 mm hole 1.5 m above the base",
    tank: {
      id: "preset-brine",
      name: "Brine tank",
      shape: "cylindrical",
      capacityM3: 300,
      diameterM: 8,
      wallHeightM: 6,
      waterHeadM: 6,
      fluid: "brine",
    },
    scenario: {
      mode: "leak",
      holeShape: "circular",
      holeDiameterM: 0.05,
      holeElevationAboveBaseM: 1.5,
      dischargeCoefficientCd: 0.61,
    },
  },
  {
    id: "rupture",
    label: "Bulk storage rupture",
    blurb: "1 000 m³, Ø12 m — instantaneous full breach",
    tank: {
      id: "preset-rupture",
      name: "Bulk tank",
      shape: "cylindrical",
      capacityM3: 1000,
      diameterM: 12,
      wallHeightM: 10,
      waterHeadM: 10,
      fluid: "water",
    },
    scenario: {
      mode: "catastrophic_breach",
      holeShape: "circular",
      holeElevationAboveBaseM: 0,
      dischargeCoefficientCd: 0.61,
      breachWidthM: 12,
      breachDevelopmentSeconds: 0,
    },
  },
];

/** Builds a complete tank from a preset plus a map location and DEM elevation. */
export function tankFromPreset(preset: Preset, lng: number, lat: number, baseElevationM: number): TankSpec {
  return {
    ...preset.tank,
    location: { lng, lat },
    baseElevationM,
  } as TankSpec;
}
