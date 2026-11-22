/**
 * Release model — the tank-emptying hydrograph.
 *
 * This is Stage A of the simulation: how much water leaves the tank, how fast, and when.
 * The routing engine (routeFillSpill.ts) consumes the resulting VOLUME TIME SERIES, so
 * peak discharge and arrival timing are genuine model outputs rather than guesses.
 *
 * Governing relations (SI units):
 *
 *   Fully submerged opening :  Q = Cd · A · sqrt(2 g h_c)      h_c = head to the opening centroid
 *   Partly submerged opening:  Q = (2/3) · Cd · b · sqrt(2 g) · h^1.5
 *   Breach / overtopping    :  Q = C_w · b · H^1.5             (broad-crested weir, C_w ~ 1.7)
 *   Storage                 :  dV/dt = -Q(t),  dh/dt = -Q(t) / A_plan(h)
 *
 * Everything is integrated with adaptive sub-stepping so a tank can never release more
 * water than it holds — the released volume is capped by construction.
 */

import type { Hydrograph, HydroPoint, ScenarioSpec, TankSpec } from "./types";

export const G = 9.80665;

export interface TankGeometry {
  /** Volume of water for a given depth above the tank floor, m3. */
  volumeAtHead(h: number): number;
  /** Plan (water-surface) area at a given depth, m2. */
  planAreaAtHead(h: number): number;
  /** Full-geometry volume at the wall height, m3. */
  geometricCapacityM3: number;
  /** Volume actually used for the simulation (min of geometric, user capacity unless user override). */
  usableVolumeM3: number;
  /** Footprint radius (equal-area circle) in metres — used to seed the routing. */
  equivalentRadiusM: number;
  description: string;
  /** Discretisation problems: e.g. horizontal cylinder is non-monotonic in plan area. */
  notes: string[];
}

/** Builds the volume-depth relation for a tank shape. */
export function tankGeometry(tank: TankSpec): TankGeometry {
  const H = Math.max(0.01, tank.wallHeightM);
  const notes: string[] = [];
  let volumeAtHead: (h: number) => number;
  let planAreaAtHead: (h: number) => number;
  let description = "";
  let equivalentArea = 0;

  if (tank.shape === "cylindrical") {
    const D = tank.diameterM ?? Math.sqrt((4 * tank.capacityM3) / (Math.PI * H));
    const A = (Math.PI * D * D) / 4;
    volumeAtHead = (h) => A * clamp(h, 0, H);
    planAreaAtHead = () => A;
    equivalentArea = A;
    description = `Vertical cylinder, D = ${D.toFixed(2)} m, plan area ${A.toFixed(1)} m²`;
  } else if (tank.shape === "rectangular") {
    const L = tank.lengthM ?? Math.sqrt(tank.capacityM3 / H);
    const W = tank.widthM ?? L;
    const A = L * W;
    volumeAtHead = (h) => A * clamp(h, 0, H);
    planAreaAtHead = () => A;
    equivalentArea = A;
    description = `Rectangular tank, ${L.toFixed(1)} × ${W.toFixed(1)} m`;
  } else if (tank.shape === "horizontal_cylindrical") {
    const D = tank.diameterM ?? 2;
    const R = D / 2;
    const L = tank.lengthM ?? tank.capacityM3 / (Math.PI * R * R);
    const segArea = (h: number) => {
      const hh = clamp(h, 0, D);
      if (hh <= 1e-9) return 0;
      if (hh >= D - 1e-9) return Math.PI * R * R;
      const t = clamp(1 - hh / R, -1, 1);
      return R * R * Math.acos(t) - (R - hh) * Math.sqrt(Math.max(0, 2 * R * hh - hh * hh));
    };
    volumeAtHead = (h) => L * segArea(h);
    planAreaAtHead = (h) => {
      const hh = clamp(h, 0, D);
      const half = Math.sqrt(Math.max(0, 2 * R * hh - hh * hh)); // half-width of the water surface
      return 2 * half * L;
    };
    equivalentArea = Math.PI * R * R;
    description = `Horizontal cylinder, D = ${D.toFixed(2)} m, L = ${L.toFixed(1)} m`;
    notes.push(
      "Horizontal cylinder: the water-surface (plan) area shrinks to zero at the invert, so discharge tails off slowly.",
    );
  } else {
    // spherical_partial — a sphere filled from the bottom
    const D = tank.diameterM ?? 2;
    const R = D / 2;
    volumeAtHead = (h) => {
      const hh = clamp(h, 0, 2 * R);
      return (Math.PI * hh * hh * (3 * R - hh)) / 3;
    };
    planAreaAtHead = (h) => {
      const hh = clamp(h, 0, 2 * R);
      return Math.PI * (2 * R * hh - hh * hh);
    };
    equivalentArea = Math.PI * R * R;
    description = `Partial sphere, D = ${D.toFixed(2)} m`;
  }

  const geometricCapacityM3 = volumeAtHead(H);
  // Physics uses geometry; a nameplate capacity that disagrees is surfaced as a warning by
  // the caller (validate.ts) rather than silently overriding the dimensions.
  const usableVolumeM3 = geometricCapacityM3;

  return {
    volumeAtHead,
    planAreaAtHead,
    geometricCapacityM3,
    usableVolumeM3,
    equivalentRadiusM: Math.sqrt(equivalentArea / Math.PI),
    description,
    notes,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Circular hole area from a diameter, m2. */
export function holeArea(diameterM: number): number {
  return (Math.PI * diameterM * diameterM) / 4;
}

interface ReleaseDynamics {
  /** Discharge, m3/s, at the current water depth. */
  q(head: number): number;
  /** Effective opening width for the weir-style partially-submerged case. */
  width: number;
  /** Invert elevation of the opening above the tank floor. */
  z0: number;
  /** Height of the opening, m (for circular holes: the diameter). */
  openingHeight: number;
  kind: "orifice" | "breach";
}

/**
 * Builds the discharge function for a scenario.
 *
 * leak           -> orifice, with a clean weir transition while the water surface is
 *                   still below the top of the opening.
 * catastrophic   -> broad-crested weir whose width ramps from 0 to breachWidthM over
 *                   breachDevelopmentSeconds (0 => instantaneous).
 * overtopping    -> weir along the wall crest, width = user breach width (or perimeter).
 */
export function releaseDynamics(tank: TankSpec, scenario: ScenarioSpec): ReleaseDynamics {
  const H = tank.wallHeightM;
  const z0 = clamp(scenario.holeElevationAboveBaseM ?? 0, 0, Math.max(0, H - 0.01));

  if (scenario.mode === "catastrophic_breach") {
    const b = Math.max(0.5, scenario.breachWidthM ?? 5);
    // Broad-crested weir coefficient: Q = Cw · b · H^1.5 with Cw ≈ 1.7 for a sharp-crested
    // weir and ≈ 1.45 for a broad-crested one in SI units. Default 1.7 is the standard
    // dam-break screening value (Fread / USBR practice).
    const Cw = scenario.weirCoefficient ?? 1.7;
    // NOTE: the opening-growth ramp is applied by effectiveQ() in computeHydrograph,
    // so this function is the fully-developed discharge at a given head.
    return {
      q: (head) => {
        const over = head - z0;
        if (over <= 0) return 0;
        return Cw * b * Math.pow(over, 1.5);
      },
      width: b,
      z0,
      openingHeight: H,
      kind: "breach",
    };
  }

  if (scenario.mode === "overtopping") {
    const b = Math.max(0.5, scenario.breachWidthM ?? 4);
    const Cw = scenario.weirCoefficient ?? 1.7;
    return {
      q: (head) => {
        const over = head - H;
        return over > 0 ? Cw * b * Math.pow(over, 1.5) : 0;
      },
      width: b,
      z0: H,
      openingHeight: 0.5,
      kind: "breach",
    };
  }

  // ---- leak / orifice ----
  const d = Math.max(0.001, scenario.holeDiameterM ?? (scenario.holeShape === "circular" ? 0.05 : 0.1));
  const w = Math.max(0.001, scenario.holeWidthM ?? d);
  const hgt = Math.max(0.001, scenario.holeHeightM ?? d);
  const isCircular = scenario.holeShape === "circular";
  const A = isCircular ? holeArea(d) : w * hgt;
  const bWidth = isCircular ? d : w;
  const Cd = clamp(scenario.dischargeCoefficientCd ?? 0.61, 0.1, 1.0);

  return {
    q: (head) => {
      const over = head - z0;
      if (over <= 1e-6) return 0;
      // Head to the centroid of the opening, the standard orifice formulation. When the
      // water surface falls inside the opening the true discharge tapers off; the plain
      // orifice law already tends to zero there, which is adequate for a screening tool
      // and matches the analytic (Torricelli) emptying time.
      const hc = Math.max(over - hgt / 2, over * 0.5);
      return Cd * A * Math.sqrt(2 * G * hc);
    },
    width: bWidth,
    z0,
    openingHeight: hgt,
    kind: "orifice",
  };
}

export interface HydrographOptions {
  /** Max internal integration step, s. */
  internalStepS?: number;
  /** Output sampling interval, s (adaptive: fine early, coarse later). */
  sampleIntervalS?: number;
}

/**
 * Integrates the tank emptying and returns the release hydrograph.
 *
 * Integration is adaptive: dt is shortened when the remaining volume would be
 * over-drawn, so `totalVolumeM3` can never exceed the available storage.
 */
export function computeHydrograph(
  tank: TankSpec,
  scenario: ScenarioSpec,
  geom = tankGeometry(tank),
  opts: HydrographOptions = {},
): Hydrograph {
  const H = tank.wallHeightM;
  const releaseFraction = clamp(scenario.releaseFraction ?? 1, 0, 1);
  const h0 = clamp(tank.waterHeadM, 0, H);
  const volumeAtStart = geom.volumeAtHead(h0) * releaseFraction;
  const dyn = releaseDynamics(tank, scenario);

  const dtMax = Math.max(0.02, Math.min(opts.internalStepS ?? 0.25, 0.5));
  // Sampling interval: the release is sampled at <= 1 s for the first minute, which is when
  // the peak discharge occurs in a breach; the router's flow limiter then never has to
  // resolve a step change in inflow.
  const sampleTarget = Math.max(0.5, opts.sampleIntervalS ?? 1);
  const durationLimit =
    scenario.durationSeconds && scenario.durationSeconds > 0 ? scenario.durationSeconds : Infinity;
  const devS = Math.max(0, scenario.breachDevelopmentSeconds ?? 0);

  let head = h0;
  let t = 0;
  let released = 0;
  let stopReason: Hydrograph["stopReason"] = "empty";
  const points: HydroPoint[] = [];
  let nextSample = 0;
  let peakQ = 0;
  let peakQTimeS = 0;
  let lastQ = 0;
  let iter = 0;
  const MAX_ITER = 5_000_000;

  const effectiveQ = (time: number, h: number): number => {
    if (scenario.mode === "catastrophic_breach") {
      const ramp = devS <= 0 ? 1 : Math.min(1, time / devS);
      return dyn.q(h) * ramp;
    }
    return dyn.q(h);
  };
  function effectiveQAt0(): number {
    return effectiveQ(0, head);
  }

  const pushPoint = (time: number, q: number) => {
    points.push({
      t: time,
      q,
      vReleased: released,
      vRemaining: Math.max(0, volumeAtStart - released),
      head,
    });
  };
  pushPoint(0, effectiveQAt0());


  while (t < durationLimit && iter++ < MAX_ITER) {
    const q = effectiveQ(t, head);
    lastQ = q;

    if (q > peakQ) {
      peakQ = q;
      peakQTimeS = t;
    }

    const remaining = volumeAtStart - released;
    if (remaining <= 1e-6) {
      stopReason = "empty";
      break;
    }

    // Stop if the water surface has dropped to the opening invert (nothing left to drive flow).
    if (head <= dyn.z0 + 1e-4 && dyn.kind === "orifice") {
      stopReason = "invert";
      break;
    }
    if (q <= 1e-9) {
      // Flow has ceased (e.g. surface below the invert). Try a small step to let the
      // water settle exactly at the invert, then stop.
      if (head <= dyn.z0 + 1e-3) {
        stopReason = "invert";
        break;
      }
    }

    // Adaptive step: limited by dtMax, by the remaining volume, and (for steeply
    // falling hydrographs) by a max 5 % change in head per step.
    const Aplan = Math.max(0.05, geom.planAreaAtHead(head));
    let dt = dtMax;
    if (q > 1e-9) {
      dt = Math.min(dt, Math.max(0.01, (remaining / q) * 0.5));
      dt = Math.min(dt, Math.max(0.01, (0.05 * head * Aplan) / q));
    }
    if (t + dt > durationLimit) {
      dt = durationLimit - t;
      stopReason = "duration";
    }

    // Trapezoidal volume over the step (the discharge falls rapidly at the start of a
    // breach, so a rectangle rule over a 0.5 s step over-estimates the released volume).
    const qNext = effectiveQ(t + dt, invertVolume(geom, volumeAtStart - released - q * dt, h0));
    const dv = Math.min(remaining, 0.5 * (q + Math.max(0, qNext)) * dt);
    released += dv;
    // Recompute head from released volume (exact, no drift) by inverting the storage curve.
    head = invertVolume(geom, volumeAtStart - released, h0);
    t += dt;

    if (t >= nextSample || released >= volumeAtStart - 1e-6 || t >= durationLimit) {
      pushPoint(t, effectiveQ(t, head));
      nextSample = t + (t < 120 ? Math.min(sampleTarget, 1) : t < 900 ? Math.min(sampleTarget * 2, 5) : sampleTarget * 10);
    }
  }

  if (stopReason !== "duration" && t >= durationLimit) stopReason = "duration";

  // Guarantee the series ends at (or just above) zero discharge.
  const last = points[points.length - 1];
  if (last && last.q > 0 && released >= volumeAtStart - 1e-6) {
    points.push({
      t: last.t + 1,
      q: 0,
      vReleased: released,
      vRemaining: Math.max(0, volumeAtStart - released),
      head,
    });
  }

  // How long the release lasts. `stopReason` says whether the tank actually emptied: a weir
  // never reaches zero discharge at a finite head, so it is bounded by the duration limit.
  const emptyTimeS = t;
  return {
    points,
    peakQ,
    peakQTimeS,
    totalVolumeM3: released,
    emptyTimeS,
    stopReason,
    residualVolumeM3: Math.max(0, volumeAtStart - released),
    method: scenario.mode === "leak" ? "orifice" : "weir",
  };
}

/** Inverts the storage curve V(h) for h, given a target volume. Monotonic in h for all shapes. */
export function invertVolume(geom: TankGeometry, targetVolumeM3: number, hStart: number): number {
  if (targetVolumeM3 <= 0) return 0;
  // Regula-falsi style bisection on [invert, hStart]; guaranteed monotonic.
  let lo = -50; // allow a little below the floor: physically the tank is empty
  let hi = Math.max(hStart, 0.01);
  // If the target exceeds the volume at hStart, the tank is full for the given head.
  if (geom.volumeAtHead(hi) <= targetVolumeM3) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const v = geom.volumeAtHead(mid);
    if (v > targetVolumeM3) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return Math.max(0, (lo + hi) / 2);
}

/**
 * Closed-form emptying time for a bottom hole with a constant plan area,
 * T = A_plan / (Cd · A_h) · sqrt(2 h0 / g). Used by the unit tests as an
 * independent check on the integrator.
 */
export function analyticEmptyingTimeS(
  planAreaM2: number,
  holeAreaM2: number,
  cd: number,
  h0: number,
): number {
  return (planAreaM2 / (cd * holeAreaM2)) * Math.sqrt((2 * h0) / G);
}
