/**
 * Shared domain types for TankBreach.
 *
 * Units are SI unless a field name says otherwise:
 *   m = metres, m2 = square metres, m3 = cubic metres, s = seconds, deg = degrees.
 */

export type TankShape =
  | "cylindrical" // vertical cylinder (most common municipal tank)
  | "rectangular" // box tank / reservoir
  | "horizontal_cylindrical" // tank lying on its side (fuel/water bowsers, small plants)
  | "spherical_partial"; // spherical pressure vessel

export type FluidKind = "water" | "wastewater" | "brine";

export interface LonLat {
  lng: number;
  lat: number;
}

export interface TankSpec {
  id: string;
  name: string;
  shape: TankShape;
  /** Nominal / nameplate capacity in m3 (user entered). Engine derives the usable volume from geometry. */
  capacityM3: number;
  /** Vertical cylinder + spherical + horizontal cylinder: diameter. */
  diameterM?: number;
  /** Rectangular: length (along local +x) and width. */
  lengthM?: number;
  widthM?: number;
  /** Wall height / max usable head above the tank floor. */
  wallHeightM: number;
  /** Current water column height above the tank floor (default = wallHeightM). */
  waterHeadM: number;
  /** ABSOLUTE elevation of the tank floor (m). Normally sampled from the DEM, editable. */
  baseElevationM: number;
  /** Height of the tank base above ground level (e.g. an elevated tank on legs). */
  baseAboveGroundM?: number;
  location: LonLat;
  /** Rotation of the rectangular footprint, degrees clockwise from north. */
  rotationDeg?: number;
  fluid: FluidKind;
}

export type ScenarioMode = "leak" | "catastrophic_breach" | "overtopping";

export interface ScenarioSpec {
  mode: ScenarioMode;
  /** Circular hole (typical pipe leak) or a rectangular opening. */
  holeShape: "circular" | "rectangular";
  /** Circular opening diameter, m (e.g. 0.05 = 50 mm). */
  holeDiameterM?: number;
  holeWidthM?: number;
  holeHeightM?: number;
  /** Height of the opening invert above the tank floor, m. 0 = bottom hole. */
  holeElevationAboveBaseM: number;
  /** Orifice discharge coefficient, dimensionless. Sharp-edged hole ~0.61. */
  dischargeCoefficientCd: number;
  /** Catastrophic breach: final effective breach width, m. */
  breachWidthM?: number;
  /** Catastrophic breach / overtopping: time for the breach to open, s. 0 => instantaneous. */
  breachDevelopmentSeconds?: number;
  /** Weir coefficient for breach / overtopping flow (SI, ~1.7). */
  weirCoefficient?: number;
  /** Stop the release after this many seconds. */
  durationSeconds?: number;
  /** Optional slow aerial loss, %/day (evaporation/drainage). Off by default = 0. */
  drainageLossPercentPerDay?: number;
  /** Fraction of stored volume actually released (default 1 = all of it). */
  releaseFraction?: number;
}

export type DemSourceId =
  | "terrarium_z15"
  | "copernicus_glo30"
  | "copernicus_glo90"
  | "srtm30"
  | "user_upload";

export interface DemMetadata {
  source: DemSourceId;
  label: string;
  /** Nominal ground sample distance in metres. */
  resolutionM: number;
  /** Stated vertical accuracy (LE90) in metres. */
  verticalAccuracyM: number | null;
  /** Surfaced to the user: is this a surface model (buildings/vegetation included)? */
  surfaceModel: boolean;
  /**
   * Slopes in the raster's own pixel footprint, which is what "native resolution" means on the
   * ground. Optional because uploaded GeoTIFFs may not carry it.
   */
  nativeCellSizeM?: number;
  attribution: string;
  licence: string;
  /** Realised cell size of the analysis grid after resampling. */
  gridCellSizeM: number;
  /** Fraction of cells that had no data and had to be interpolated. */
  nodataFraction: number;
  minZM: number;
  maxZM: number;
}

/** Local azimuthal-equidistant projection anchored at the tank. All engine maths happens here. */
export interface LocalCRS {
  lon0: number;
  lat0: number;
  /** Metres per projection unit (1 for a metric CRS). */
  unitScale: number;
  proj4: string;
}

export interface Grid {
  nx: number;
  ny: number;
  /** Local easting of the centre of cell (0,0), metres. */
  x0: number;
  /** Local northing of the centre of cell (0,0), metres. */
  y0: number;
  /** Cell size, metres. Cells are square. */
  dx: number;
  /** Ground elevation, row-major, row 0 = southernmost (minimum northing). */
  z: Float32Array;
  crs: LocalCRS;
}

export interface GridExtent {
  /** Local-projection bounding box. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SimulationOptions {
  /** Manning roughness n. */
  manningN: number;
  /** Infiltration / abstraction rate in mm/hour (0 = impervious). */
  infiltrationMmPerHr: number;
  /** Minimum depth (m) treated as "affected" in statistics and extents. */
  reportingDepthM: number;
  /** Simulation duration cap, seconds. */
  maxDurationS: number;
  /** Number of animation frames to keep. */
  frameCount: number;
  /** Approximate max number of grid cells (drives auto-coarsening). */
  maxCells: number;
  /** Requested analysis cell size in metres (auto-coarsened if maxCells is exceeded). */
  cellSizeM?: number;
  /** Domain radius in metres (auto if omitted). */
  domainRadiusM?: number;
  /** Treat buildings as blocked cells (walls) if footprints were supplied. */
  buildingsAsObstacles: boolean;
  /** Apply a light 3x3 smoothing to the DEM to remove single-cell spikes. */
  smoothDem: boolean;
  /**
   * Impact-assessment boundary in square kilometres. Cells outside it are still routed (the
   * physics does not stop at a drawn line) but are excluded from the damage summary and the
   * exported polygons. Omitted = assess the whole analysis domain.
   */
  impactAreaKm2?: number;
}

export interface HydroPoint {
  t: number;
  q: number;
  vReleased: number;
  vRemaining: number;
  head: number;
}

export interface Hydrograph {
  /** Uniformly-ish spaced samples; t in seconds. */
  points: HydroPoint[];
  peakQ: number;
  peakQTimeS: number;
  totalVolumeM3: number;
  /** Time the tank is empty; Infinity when the release stops for another reason (a weir
   *  keeps discharging until the head reaches the invert). */
  emptyTimeS: number;
  /** Why the release stopped. */
  stopReason: "empty" | "duration" | "duration_cap" | "invert";
  /** Volume still in the tank when the release stopped. */
  residualVolumeM3: number;
  method: "orifice" | "weir" | "orifice+weir";
}

export interface MassBalance {
  releasedM3: number;
  wetM3: number;
  infiltrationM3: number;
  outflowM3: number;
  tankResidualM3: number;
  /** released - (wet + infiltration + outflow) */
  errorM3: number;
  /** Volume clipped because a cell's depth went negative — a solver-health figure. */
  clampedM3: number;
  errorPercent: number;
  ok: boolean;
}

export interface FrameStats {
  t: number;
  wetAreaM2: number;
  maxDepthM: number;
  volumeM3: number;
  outflowM3: number;
}

export interface ClassStat {
  id: string;
  label: string;
  minM: number;
  maxM: number;
  areaM2: number;
  cellCount: number;
  colour: string;
}

export interface SimulationResult {
  /** Max depth over the whole event, metres. */
  maxDepth: Float32Array;
  /** First arrival time, seconds (NaN / -1 if never wet). */
  arrivalTime: Float32Array;
  /** Peak depth-integrated velocity magnitude, m/s. */
  maxVelocity: Float32Array;
  /** Total time the cell was wet, seconds. */
  wetDuration: Float32Array;
  /** Quantised depth snapshots (centimetres, capped) for the timeline animation. */
  frames: Uint16Array[];
  frameTimes: number[];
  frameStats: FrameStats[];
  /** Coarse depth-class raster for fast rendering (id per cell, 255 = dry). */
  depthClass: Uint8Array;
  hazardClass: Uint8Array;
  mass: MassBalance;
  classes: ClassStat[];
  stats: {
    affectedAreaM2: number;
    maxDepthM: number;
    meanDepthAffectedM: number;
    maxVelocityMs: number;
    maxExtentDistanceM: number;
    firstArrivalS: number;
    peakDepthTimeS: number;
    wetCellCount: number;
  };
  hydro: Hydrograph;
  grid: Grid;
  options: SimulationOptions;
  /** Damage band per cell (0 = none), inside the impact boundary only. */
  damageClass: Uint8Array;
  /** 0–100 damage score per cell (Hazard×Depth ranking, see damageFromResult). */
  damageScore: Uint8Array;
  damageBands: DamageBand[];
  damageMethod: "hazard_depth" | "depth_only";
  flow: FlowField;
  /** Net integrated X-transport flux per cell (m³/s·s = m²/m, positive East). */
  flowX?: Float32Array;
  /** Net integrated Y-transport flux per cell (m²/m, positive North). */
  flowY?: Float32Array;
  /** Velocity X at peak flow (m/s). */
  velX?: Float32Array;
  /** Velocity Y at peak flow (m/s). */
  velY?: Float32Array;
  /** Ground elevation at the tank location, sampled from the DEM used for the run. */
  tankGroundElevationM: number | null;
  /** Wall-clock compute time, ms. */
  computeMs: number;
  /** Stable hash of the inputs + output summary, for reproducibility checks. */
  hash: string;
  warnings: string[];
}

/** Damage band for the impact assessment. 0 = outside the boundary or dry. */
export type DamageClass = 0 | 1 | 2 | 3;

export interface DamageBand {
  id: "low" | "medium" | "high";
  label: string;
  /** Lower bound of the band's score (inclusive). */
  minScore: number;
  maxScore: number | null;
  /** Hex colour used on the map, in the legend and in every export. */
  colour: string;
  areaM2: number;
  cellCount: number;
  /** Share of the assessed (inside-boundary) area, 0–1. */
  fractionOfBoundary: number;
}

/**
 * One arrow of the flow-direction field. `dirDeg` is the compass bearing the water travels
 * towards (0 = north); `speedMs` is the depth-averaged outgoing speed.
 */
export interface FlowVector {
  x: number;
  y: number;
  lng: number;
  lat: number;
  dirDeg: number;
  speedMs: number;
  depthM: number;
  /** Magnitude of the net outgoing flux, m²/s. */
  flux: number;
}

export interface MajorFlowArrow {
  /** Lon/lat coordinates of the arrow start at the tank/source. */
  fromLng: number;
  fromLat: number;
  /** Lon/lat coordinates of the arrow tip. */
  toLng: number;
  toLat: number;
  /** Compass bearing in degrees (0 = North, 90 = East, 180 = South, 270 = West). */
  bearingDeg: number;
  /** Length of the arrow in meters. */
  lengthM: number;
  /** Shaft width in meters (scaled by flow magnitude and damage severity). */
  widthM: number;
  /** Head width in meters. */
  headWidthM: number;
  /** Head length in meters. */
  headLengthM: number;
  /** Peak speed along this flow corridor, m/s. */
  speedMs: number;
  /** Total flux / discharge metric along this corridor. */
  flux: number;
  /** Damage severity ("high" | "medium" | "low"). */
  damageLevel: "high" | "medium" | "low";
  /** Arrow polygon coordinates in [lng, lat] for GIS and map rendering. */
  polygon: [number, number][];
  /** Fluent curvilinear polyline path [lng, lat][] following terrain contours like a snake. */
  path?: [number, number][];
  /** Role of the arrow: "primary" for the dominant path, "secondary" if flow bifurcates. */
  role: "primary" | "secondary";
  /** Descriptive label, e.g. "Dominant flow — South (182°)". */
  label: string;
}

/**
 * A physical node within the hydraulic flow network (breach origin, bifurcation junction, or basin receptor).
 */
export interface FlowNode {
  id: string;
  lngLat: [number, number];
  role: "origin" | "junction" | "receptor";
  label: string;
}

/**
 * A physical drainage branch within the connected hydraulic flow network.
 * Links the tank breach origin to downstream inundated basins along active thalwegs.
 */
export interface FlowNetworkBranch {
  id: string;
  path: [number, number][];
  arrowHead?: [number, number][];
  headLngLat?: [number, number];
  fromNodeId?: string;
  toNodeId?: string;
  role: "trunk" | "branch" | "tributary";
  order: number;
  lengthM: number;
  widthM: number;
  speedMs: number;
  flux: number;
  damageLevel: "high" | "medium" | "low";
  label: string;
  bearingDeg: number;
}

/**
 * A fluid, snake-like streamline tracing the physical path of water downhill from the leak.
 * Multiple streamlines radiate in active drainage directions around the tank.
 */
export interface FlowStreamline {
  id: string;
  /** Curvilinear path in [lng, lat] coordinates following terrain contours and momentum. */
  path: [number, number][];
  /** Tangent bearing at the arrow head in degrees (0 = North). */
  headBearingDeg: number;
  /** Total length along the curved path in meters. */
  lengthM: number;
  /** Streamline line width in meters (scaled by discharge and damage, e.g. 2.5m - 12m). */
  widthM: number;
  /** Peak speed along this stream path, m/s. */
  speedMs: number;
  /** Discharge flux metric. */
  flux: number;
  /** Damage classification. */
  damageLevel: "high" | "medium" | "low";
  /** Role: "primary" for dominant corridor, "branch" for secondary outflow directions. */
  role: "primary" | "branch";
  /** Descriptive label, e.g. "Primary flow corridor — South (182°)" */
  label: string;
  /** Tip coordinate [lng, lat]. */
  headLngLat: [number, number];
  /** Arrowhead polygon points in [lng, lat] oriented along the curve end. */
  arrowHead: [number, number][];
}

export interface FlowField {
  /** Sampled arrows, strongest first (already thinned for legibility). */
  vectors: FlowVector[];
  /** Flow-weighted mean direction over the assessment area, compass degrees. */
  meanDirDeg: number;
  /** Circular concentration 0–1 (1 = all water heading the same way). */
  concentration: number;
  /** The direction carrying the largest share of the outflowing volume. */
  dominantDirDeg: number;
  /** 8-point compass label for the dominant direction, e.g. "SW". */
  dominantLabel: string;
  /** Sampled speed at the 95th percentile, used to scale the arrows. */
  speedP95Ms: number;
  /** Total assessed area inside the boundary, m². */
  boundaryAreaM2: number;
  /** Inundated area inside the boundary, m². */
  boundaryWetAreaM2: number;
  /** Share of the boundary that got wet, 0–1. */
  boundaryWetFraction: number;
  /** The prominent primary direction arrow originating from the tank. */
  primaryArrow?: MajorFlowArrow;
  /** All major direction arrows (primary and secondary branch if flow splits). */
  majorArrows?: MajorFlowArrow[];
  /** Fluid, snake-like streamlines radiating from the leak point along multiple directions. */
  streamlines?: FlowStreamline[];
  /** Connected dendritic drainage network linking the tank breach to downstream basins. */
  flowNetwork?: FlowNetworkBranch[];
  /** Key nodal stations: breach origin, corridor forks, and downstream basin receptors. */
  nodes?: FlowNode[];
}

export interface Building {
  id: string;
  /** Local projection geometry (list of rings; ring 0 = outer). */
  rings: number[][][];
  kind?: string;
  name?: string;
}

export interface BuildingImpact {
  id: string;
  name?: string;
  kind?: string;
  maxDepthM: number;
  arrivalTimeS: number;
  footprintAreaM2: number;
  footprintCentroid: LonLat;
}

export interface RoadImpact {
  id: string;
  name?: string;
  highway?: string;
  /** Length of the road inside the reported extent, metres. */
  affectedLengthM: number;
  maxDepthM: number;
  totalLengthM: number;
}
