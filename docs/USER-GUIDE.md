# TankBreach — how to use it, step by step

A key-less, browser-only screening tool: pick a tank on real terrain, define a leak or breach,
run a 2-D shallow-water model, and read the result in three damage bands with a flow-direction
field. Everything stays on your machine — no account, no API key, no server.

> The app always says it, so I'll say it once here too: this is a **screening tool, not a
> design-grade dam-break study**. It tells you where water goes and roughly how bad it gets
> there. It does not certify anything as safe.

---

## 0. Open the app

```bash
cd tankbreach
npm ci          # first time only — needs package-lock.json present
npm run dev     # then open http://localhost:5173
```

If `npm ci` says *"can only install with an existing package-lock.json"*, the copy you have
arrived without the lockfile — run `npm install` instead.

**Do not run `npm audit fix --force`** on this project. It upgrades Vite and MapLibre across
majors and can leave you with a basemap that never loads. The pinned versions are already
audit-clean; see the dependency table in the README.

Production build instead: `npm run build && npm run serve` (port 4173).

You'll see the map (Madinah by default), a **sidebar** on the left with five tabs —
**Tank · Scenario · Terrain · Results · Impact** — plus **⇄** for compare mode, and the top bar
with the basemap switch, the red disclaimer, **▶ Run simulation** and the export buttons.

On a phone the sidebar starts collapsed; the **▶** arrow at its top-left edge opens it.

---

## 1. Put a tank on the ground

**Fastest route (recommended):**

1. Open the **Tank** tab.
2. Use **Start from a preset** and pick one:

   | Preset | What it is |
   | --- | --- |
   | Municipal rooftop tank | 500 m³, Ø10 m, 6.4 m wall — 100 mm bottom-hole leak |
   | Elevated neighbourhood tank | smaller, elevated — leak |
   | Farm irrigation reservoir | — leak |
   | Industrial brine tank | — leak |
   | Bulk storage rupture | 1 000 m³, Ø12 m — instantaneous full breach |

   A preset sets **both** the tank and the release mode, so after choosing it you can press
   Run straight away.

3. Fine-tune in the same tab: **Tank name**, **Longitude**, **Latitude**, **Diameter** (or
   **Length**/**Width** for rectangular), **Wall height**, **Water level**, **Nameplate
   capacity**, **Tank floor elevation**, **Base above ground (elevated tanks)**.

**Placing by hand instead:** press **📍 Move / place tank**, then click the map. The marker is
draggable afterwards. **⌖ My location** centres on you; **Clear** removes the tank.

The **Tank floor elevation** matters more than anything else here — it is the datum the whole
release calculation starts from. When a preset is chosen the app samples the DEM at that point
and sits the tank on the actual ground.

---

## 2. Define the release (Scenario tab)

Choose **Scenario type**:

| Type | What you control | Use it for |
| --- | --- | --- |
| **Leak / hole in the wall or base** | **Opening shape** (circular/rectangular), **Hole diameter** or **Opening width** + **Opening height**, **Opening invert above tank floor**, **Discharge coefficient Cd**, **Release duration** | pinhole to large pipe failure — a slow, long release |
| **Catastrophic breach (wall failure)** | **Breach width**, **Breach development time**, **Cd**, **Release duration** | wall collapse — a short, violent release |
| **Overtopping / spill over the wall crest** | weir geometry | filling/overfill spilling over the rim |

A **Q(t)** chart previews the release hydrograph live as you type, before you run anything.
Watch **Peak discharge** and the emptying time — they tell you what kind of event you've built.

---

## 3. Set up the terrain and the model (Terrain tab)

You can leave every one of these alone on a first run. When you need them:

- **DEM source** — AWS Terrain Tiles (30 m, default) or Copernicus GLO-30.
  The card **DEM actually used** reports native resolution, ground pixel size, vertical
  accuracy, DSM vs DTM, elevation range, no-data fraction, licence. Read it: a DSM contains
  buildings and trees, so depths over a dense roofscape are approximate.
- **Analysis cell size** (m) — 12 m default; smaller = sharper but slower.
- **Cell budget** — the hard cap; the cell size coarsens automatically to respect it.
- **Reporting depth threshold** — thinner water is treated as dry (default 0.005 m).
- **Routing duration cap** (hours) and **Domain radius** (km, blank = automatic). The domain is
  how far water is allowed to travel; **anything outside it is not modelled**.
- **Manning roughness n** and **Infiltration / surface loss** — friction and soil losses.
- **Smooth the DEM** — removes single-cell spikes that would otherwise trap water.
- **3-D terrain** — tilt the view; drag with **Ctrl** to pitch. Raster overlays stay draped.
- **Analysis layers** — checkboxes with opacity sliders for every overlay, including
  **Damage bands**, **Direction of flow** and **Impact boundary**.

---

## 4. Run it

Press **▶ Run simulation** in the top bar. It runs in a Web Worker, so the interface stays
responsive; the button becomes **■ Cancel** while it works. Stages: DEM tiles → grid →
hydrograph → routing → damage and flow assessment.

A 700 k-cell run takes seconds to a minute depending on the DEM fetch. When it finishes the map
auto-frames the modelled extent, the depth raster appears and the timeline fills in.

---

## 5. Read the results (Results tab)

Four sub-tabs:

- **Summary** — volume released, peak discharge, affected area, max depth, peak velocity, time
  to empty, max extent from the tank, solver time; then **Depth classes** (max over the event)
  as a legend with areas and percentages.
- **Exposure** — buildings and roads from OpenStreetMap inside the flooded extent, with the
  depth at each. If Overpass is unreachable it says **"Not assessed"** — which is *not* the same
  as "no assets affected".
- **Balance** — the mass balance. Anything beyond **±1 %** means the run should be distrusted.
- **Assumptions** — exactly what the model does and does not do, plus the run hash.

Under the map: the **timeline**. Drag it (or press ▶ / space) to watch the flood propagate;
**2×/4×/8×** sets playback speed. The legend bottom-left changes with the active layer; the
strip at the very bottom carries the attribution and the disclaimer.

---

## 6. The impact assessment (Impact tab) — boundary, bands, flow direction

This is the part you asked for. It works on the finished run, so nothing is re-simulated.

1. **Assessment boundary** — type an area in **km²** (or tap **0.25 / 1 / 4 / 9**) and press
   **Apply** (or Enter). It is a square centred on the tank. `1 km²` = a 1 km × 1 km square.
   Press **Zoom** to frame the classified cells.
2. **Damage inside the boundary** — the map shade is a **continuous heat map**: a gradient of
   the damage score from pale yellow (barely damaging) through orange to deep red (worst). The
   three bands are drawn on top as crisp outlines, and listed with area and share:

   | Band | Rule |
   | --- | --- |
   | **Low** | wet, below both the medium depth and medium depth × velocity thresholds |
   | **Medium** | depth ≥ 0.10 m **or** depth × velocity ≥ 0.5 m²/s |
   | **High** | depth ≥ 0.50 m **or** depth × velocity ≥ 1.0 m²/s **or** depth ≥ 1.5 m |

   The line above the bands tells you which method was used: **depth × velocity** when the
   flow is actually moving, **depth only** when it is too slow for velocity to matter.
3. **Direction of flow** — the arrows on the map, plus four numbers:
   **Predominant** (compass sector carrying most of the moving water), **Mean bearing**
   (area × depth-weighted, in degrees clockwise from north), **Peak flow speed**, and
   **Directional focus** (0–1: near 1 = one broad front, low = the flow splits).
   Bearing is the direction the water travels **towards**.
4. **Map layers** — toggle **Damage bands**, **Direction of flow**, **Impact boundary**.

**One warning to take seriously:** if your boundary is bigger than the area the model actually
simulated, a yellow banner tells you how many km² are outside it. That area is **not assessed** —
never read it as "unaffected". Shrink the boundary or raise the **Domain radius** in the Terrain
tab to cover it.

---

## 7. Export

Two places: the **Export** card on the right, and the **Impact** tab (button row at the bottom).
The top bar carries the always-on shortcuts (PNG, PDF, KMZ, GeoJSON, ?).

| Button | You get |
| --- | --- |
| **PNG map** | 2× map composite: title, legend, north arrow, scale, timestamp, run hash, attribution, disclaimer |
| **PDF report** | 3-page A4: specifications + map; classes, hazard, exposure, Q(t)/V(t) charts, mass balance; provenance, assumptions, limitations, manifest |
| **KMZ (Google Earth)** | tank + breach placemarks, depth/hazard/arrival GroundOverlays, class areas, exposed buildings, legend |
| **GeoJSON** | per-cell polygons with depth, arrival, velocity, depth class, hazard class, plus buildings and run metadata |
| **Run manifest (JSON)** | the full input/output provenance |
| **Damage bands KMZ** | one folder per band + the arrows + the boundary, with the legend card overlaid |
| **Damage bands SHP** | zipped ESRI shapefile: `damage_bands`, `flow_direction`, `boundary` — each `.shp/.shx/.dbf/.prj/.cpg`, WGS84, plus a README |
| **Damage bands GeoJSON** | band polygons, boundary, arrows, flow summary |
| **Damage bands DXF** | `DAMAGE_LOW` / `DAMAGE_MEDIUM` / `DAMAGE_HIGH` / `FLOW` / `BOUNDARY` layers for CAD |

Every one of them carries the screening disclaimer and the run hash. The SHP is a genuine
shapefile (shape types 5 and 3, dBASE III attributes) — it opens in QGIS, ArcGIS and PostGIS
without conversion.

---

## 8. Compare scenarios (⇄ tab)

1. Each row is a scenario: choose its **type**, give it a **label**, set the **opening width**.
   **+ Add scenario** (up to 4), **Copy current** duplicates what's in the Scenario tab.
2. **Run N scenarios** — they run back to back.
3. You get a side-by-side table (volume, peak Q, area, depth, velocity, extent, mass balance)
   and a **difference map** of the two results.
4. **Download comparison PDF** produces a 2-page A4 comparison.

---

## 9. Save and share

At the bottom of the sidebar, **Scenario file**:

- Type a name → **Save** (stored in this browser only).
- **Download JSON** → a scenario file you can email or commit.
- **Open JSON** → load one back.
- **Copy link** → a `#s=…` permalink that rebuilds the exact inputs on someone else's machine.
  Results are deliberately **not** in the link — the recipient re-runs the model, so nobody is
  ever shown a raster that doesn't match its inputs.

**EN / العربية** in the top bar switches language; Arabic flips the whole layout to full RTL.

---

## 10. Reading the numbers without fooling yourself

- **Depths are only as good as the DEM** (typically ±2–4 m vertical). The app never propagates
  DEM error into the depth bands, so treat absolute depths as approximate.
- **Bands rank modelled loading on a cell** — not the habitability of a place. No output ever
  says a location is safe.
- **Check the mass balance** on every run; beyond ±1 % the run is telling you something broke.
- **Check "Mass balance" on every run.** If it ever reads out of tolerance, the extent and the
  bands for that run are unreliable — re-run before quoting anything from it.
- **Thin films stay thin.** The model routes water, it doesn't invent it; a 12 m cell holding
  5 mm is a real result, not a bug.
- **The domain edge is an open outfall.** Water leaving it is gone, not ponded.

---

## 11. If something looks wrong

| Symptom | Cause / fix |
| --- | --- |
| "Not assessed (Overpass unavailable)" | the OSM mirrors are down or slow. Exposure is the only affected part; the hydraulics are unaffected. |
| A yellow banner says part of the boundary is outside the domain | intentional. Shrink the boundary or increase **Domain radius**. |
| No water inside the boundary | the run genuinely kept the water somewhere else (or it infiltrated). It's a result, not a clearance — check the timeline. |
| Run takes very long | lower **Cell budget**, raise **Analysis cell size**, or shorten **Routing duration cap**. |
| Exports are greyed out | they need a finished run. |
| Sidebar in the way on a phone | it's an overlay; tap **▶** at its top-left edge to collapse it. |
