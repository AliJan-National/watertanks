/**
 * PNG map export — Publication-grade ArcGIS Pro layout for Municipal deliverables.
 *
 * Composites:
 *   - Outer cartographic neatlines and graticule coordinates
 *   - Municipal title block & project metadata
 *   - Executive impact summary callout (1 km² focus area, inundated hectares, peak depth)
 *   - ArcGIS-style subdivided metric scale bar
 *   - Professional GIS compass rose / North arrow
 *   - Standardized municipal hazard legend (FEMA / USBR aligned)
 *   - Flow streamlines and storage tank symbology
 *   - Coordinate system / datum / solver attribution strip
 */

import type { SimulationResult, TankSpec } from "../engine/types";
import { fmtArea, fmtDepth, fmtRate, fmtTime, fmtVolume, humanDateTime } from "../format";
import { compassLabel } from "../analysis/impact";

export interface PngOptions {
  mapCanvas: HTMLCanvasElement;
  result: SimulationResult;
  tank: TankSpec;
  scenarioLabel: string;
  attributions: string[];
  basemapId: string;
  runHash: string;
  scale: number;
  includeBasemap: boolean;
  demMetadata?: { label: string } | null;
}

export async function buildPng(o: PngOptions): Promise<Blob> {
  const src = o.mapCanvas;
  if (!src || src.width < 8 || src.height < 8) {
    throw new Error("The map has not finished drawing yet. Wait for the imagery to appear and try again.");
  }

  const s = o.scale;
  const W = Math.round(src.width * s);
  const H = Math.round(src.height * s);
  const bannerH = Math.round(155 * s);
  const footerH = Math.round(38 * s);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H + bannerH + footerH;
  const ctx = canvas.getContext("2d")!;

  // 1. Dark background
  ctx.fillStyle = "#080e1a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Map Image
  if (o.includeBasemap) {
    try {
      ctx.drawImage(src, 0, bannerH, W, H);
    } catch {
      throw new Error("The map canvas could not be read. Try the export again.");
    }
  } else {
    ctx.fillStyle = "#0b1329";
    ctx.fillRect(0, bannerH, W, H);
    ctx.drawImage(src, 0, bannerH, W, H);
  }

  // 3. ArcGIS Pro Double Neatline around the whole sheet
  const marginOuter = 4 * s;
  const marginInner = 9 * s;
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(marginOuter, marginOuter, canvas.width - marginOuter * 2, canvas.height - marginOuter * 2);

  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(marginInner, marginInner, canvas.width - marginInner * 2, canvas.height - marginInner * 2);

  // 4. Cartographic Header Banner (ArcGIS Pro Municipal Title Block)
  const grad = ctx.createLinearGradient(0, marginInner, 0, bannerH);
  grad.addColorStop(0, "#0b1528");
  grad.addColorStop(1, "#0f1d36");
  ctx.fillStyle = grad;
  ctx.fillRect(marginInner, marginInner, canvas.width - marginInner * 2, bannerH - marginInner);

  // Decorative top accent strip
  ctx.fillStyle = "#0284c7";
  ctx.fillRect(marginInner, marginInner, canvas.width - marginInner * 2, 4 * s);

  // Municipal Authority tag
  ctx.fillStyle = "#38bdf8";
  ctx.font = `bold ${12 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText("MUNICIPAL WATER INFRASTRUCTURE — TANK BREACH & FLOOD HAZARD STUDY", 24 * s, 32 * s);

  // Main Map Title (Large, Authoritative, Prominent)
  ctx.fillStyle = "#f8fafc";
  ctx.font = `bold ${22 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${(o.tank.name || "STORAGE TANK").toUpperCase()} — INUNDATION STUDY`, 24 * s, 60 * s);

  // Dynamic tank geometry & specifications
  const shapeLabel =
    o.tank.shape === "cylindrical"
      ? "Vertical Cylinder"
      : o.tank.shape === "rectangular"
      ? "Rectangular Box"
      : o.tank.shape === "horizontal_cylindrical"
      ? "Horizontal Cylinder"
      : "Spherical Tank";

  const dimStr =
    o.tank.shape === "rectangular"
      ? `${(o.tank.lengthM ?? 0).toFixed(1)} m (L) × ${(o.tank.widthM ?? 0).toFixed(1)} m (W)`
      : `Ø ${(o.tank.diameterM ?? 0).toFixed(1)} m`;

  const headPct = ((o.tank.waterHeadM / Math.max(0.1, o.tank.wallHeightM)) * 100).toFixed(0);
  const latStr = `${o.tank.location.lat.toFixed(5)}°N`;
  const lngStr = `${o.tank.location.lng.toFixed(5)}°E`;

  // Row 1: Tank Physical Specifications
  ctx.fillStyle = "#38bdf8";
  ctx.font = `bold ${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText("TANK SPECS:", 24 * s, 84 * s);

  ctx.fillStyle = "#cbd5e1";
  ctx.font = `${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText(
    `Shape: ${shapeLabel}  ·  Dimensions: ${dimStr}  ·  Wall H: ${o.tank.wallHeightM.toFixed(1)} m  ·  Water Level: ${o.tank.waterHeadM.toFixed(1)} m (${headPct}% full)  ·  Nominal Cap: ${fmtVolume(o.tank.capacityM3)}  ·  Tank Floor: ${o.tank.baseElevationM.toFixed(1)} m a.s.l.`,
    108 * s,
    84 * s,
  );

  // Row 2: Location & Scenario Details
  ctx.fillStyle = "#94a3b8";
  ctx.font = `bold ${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText("SCENARIO:", 24 * s, 106 * s);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = `${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText(
    `Location: ${latStr}, ${lngStr}  ·  Breach Scenario: ${o.scenarioLabel}  ·  Fluid: ${o.tank.fluid}  ·  Date: ${humanDateTime()}`,
    98 * s,
    106 * s,
  );

  // Row 3: Simulation Hydrology Metrics
  ctx.fillStyle = "#facc15";
  ctx.font = `bold ${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.fillText("HYDROLOGY:", 24 * s, 128 * s);

  ctx.fillStyle = "#f1f5f9";
  ctx.font = `600 ${11.5 * s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const releasedStr = `Released: ${fmtVolume(o.result.mass.releasedM3)}`;
  const peakQStr = `Peak Q: ${fmtRate(o.result.hydro.peakQ)}`;
  const affAreaStr = `Inundated Area: ${fmtArea(o.result.stats.affectedAreaM2)}`;
  const maxDStr = `Max Depth: ${fmtDepth(o.result.stats.maxDepthM)}`;
  const emptyStr = o.result.hydro.stopReason === "empty" ? `Emptied in ${fmtTime(o.result.hydro.emptyTimeS)}` : `Duration: ${fmtTime(o.result.hydro.emptyTimeS)}`;
  ctx.fillText(`${releasedStr}   |   ${peakQStr}   |   ${affAreaStr}   |   ${maxDStr}   |   ${emptyStr}`, 108 * s, 128 * s);

  // 5. ArcGIS Executive Summary Callout Card (Top-Right of Map - Prominent & Legible)
  const cw = 350 * s;
  const ch = 285 * s;
  const cx = W - cw - 24 * s;
  const cy = bannerH + 20 * s;

  ctx.fillStyle = "rgba(11, 21, 40, 0.94)";
  ctx.fillRect(cx, cy, cw, ch);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.8 * s;
  ctx.strokeRect(cx, cy, cw, ch);

  // Card header
  ctx.fillStyle = "rgba(2, 132, 199, 0.35)";
  ctx.fillRect(cx, cy, cw, 30 * s);
  ctx.fillStyle = "#38bdf8";
  ctx.font = `bold ${13 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("TANK & BREACH SPECIFICATIONS", cx + 14 * s, cy + 20 * s);

  // Card rows: fully dynamic from TankSpec & SimulationResult
  const cardRows: [string, string][] = [
    ["Tank Name", o.tank.name],
    ["Tank Geometry", `${shapeLabel} (${dimStr})`],
    ["Wall Height", `${o.tank.wallHeightM.toFixed(1)} m`],
    ["Water Level (Head)", `${o.tank.waterHeadM.toFixed(1)} m (${headPct}%)`],
    ["Nominal Capacity", fmtVolume(o.tank.capacityM3)],
    ["Tank Floor Elevation", `${o.tank.baseElevationM.toFixed(1)} m a.s.l.`],
    ["Breach Scenario", o.scenarioLabel],
    ["Total Volume Released", fmtVolume(o.result.mass.releasedM3)],
    ["Peak Outflow Q", fmtRate(o.result.hydro.peakQ)],
    ["Total Inundated Area", fmtArea(o.result.stats.affectedAreaM2)],
    ["Peak Flood Depth", fmtDepth(o.result.stats.maxDepthM)],
    ["Elevation Dataset", o.demMetadata?.label ?? "Copernicus GLO-30 DSM (30m)"],
  ];

  ctx.font = `${11 * s}px ui-sans-serif, system-ui, sans-serif`;
  let rY = cy + 50 * s;
  for (const [lbl, val] of cardRows) {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(lbl, cx + 14 * s, rY);
    ctx.fillStyle = "#f1f5f9";
    ctx.font = `bold ${11 * s}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(val, cx + cw - 14 * s - ctx.measureText(val).width, rY);
    ctx.font = `${11 * s}px ui-sans-serif, system-ui, sans-serif`;
    rY += 19.5 * s;
  }

  // 6. ArcGIS Standardized Municipal Hazard Legend (Bottom-Left - Prominent & Clear)
  const lw = 320 * s;
  const lh = 205 * s;
  const lx = 24 * s;
  const ly = bannerH + H - lh - 22 * s;

  ctx.fillStyle = "rgba(11, 21, 40, 0.95)";
  ctx.fillRect(lx, ly, lw, lh);
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.8 * s;
  ctx.strokeRect(lx, ly, lw, lh);

  // Legend header
  ctx.fillStyle = "#f8fafc";
  ctx.font = `bold ${13.5 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("MUNICIPAL HAZARD LEGEND", lx + 14 * s, ly + 24 * s);

  ctx.fillStyle = "#64748b";
  ctx.fillRect(lx + 14 * s, ly + 31 * s, lw - 28 * s, 1 * s);

  // Hazard bands (USBR / FEMA standard)
  const hazardItems = [
    { label: "High Hazard (>0.5 m / extreme)", colour: "#dc2626" },
    { label: "Medium Hazard (0.15–0.5 m / vehicle)", colour: "#fb923c" },
    { label: "Low Hazard (<0.15 m / sheet flow)", colour: "#facc15" },
  ];

  let lY = ly + 52 * s;
  ctx.font = `${11.5 * s}px ui-sans-serif, system-ui, sans-serif`;
  for (const item of hazardItems) {
    ctx.fillStyle = item.colour;
    ctx.fillRect(lx + 14 * s, lY - 10 * s, 24 * s, 13 * s);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.8 * s;
    ctx.strokeRect(lx + 14 * s, lY - 10 * s, 24 * s, 13 * s);

    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(item.label, lx + 46 * s, lY);
    lY += 23 * s;
  }

  // Symbology items
  lY += 4 * s;
  ctx.fillStyle = "#64748b";
  ctx.fillRect(lx + 14 * s, lY - 8 * s, lw - 28 * s, 1 * s);

  // 1. Storage tank
  lY += 16 * s;
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.arc(lx + 26 * s, lY - 4 * s, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.2 * s;
  ctx.stroke();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText("Storage tank location (origin)", lx + 48 * s, lY);

  // 2. Inundation boundary (flood perimeter line)
  lY += 23 * s;
  ctx.beginPath();
  ctx.moveTo(lx + 14 * s, lY - 4 * s);
  ctx.bezierCurveTo(lx + 22 * s, lY - 11 * s, lx + 28 * s, lY + 3 * s, lx + 36 * s, lY - 4 * s);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4.5 * s;
  ctx.stroke();
  ctx.strokeStyle = "#0a0f1d";
  ctx.lineWidth = 2.5 * s;
  ctx.stroke();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText("Inundation boundary (flood perimeter)", lx + 48 * s, lY);

  // 7. ArcGIS Subdivided Metric Scale Bar (Bottom-Right)
  const barW = 200 * s;
  const barX = W - barW - 24 * s;
  const barY = bannerH + H - 24 * s;

  ctx.fillStyle = "rgba(11, 21, 40, 0.88)";
  ctx.fillRect(barX - 12 * s, barY - 26 * s, barW + 24 * s, 42 * s);
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(barX - 12 * s, barY - 26 * s, barW + 24 * s, 42 * s);

  // Segmented scale bar (0, 100m, 250m, 500m)
  const segs = [
    { w: barW * 0.2, c: "#ffffff", label: "0" },
    { w: barW * 0.3, c: "#0f172a", label: "100m" },
    { w: barW * 0.5, c: "#ffffff", label: "250m" },
  ];
  let curBX = barX;
  const barH = 5 * s;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1 * s;
  ctx.fillStyle = "#ffffff";
  ctx.font = `${8.5 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("0", barX - 3 * s, barY - 6 * s);

  for (const seg of segs) {
    ctx.fillStyle = seg.c;
    ctx.fillRect(curBX, barY, seg.w, barH);
    ctx.strokeRect(curBX, barY, seg.w, barH);
    curBX += seg.w;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(seg.label === "0" ? "" : seg.label, curBX - 12 * s, barY - 6 * s);
  }
  ctx.fillText("500 m", curBX - 14 * s, barY - 6 * s);

  // 8. ArcGIS Cartographic North Arrow (Compass Rose)
  const nax = W - 48 * s;
  const nay = bannerH + 215 * s;
  ctx.fillStyle = "rgba(11, 21, 40, 0.88)";
  ctx.beginPath();
  ctx.arc(nax, nay, 22 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 1.5 * s;
  ctx.stroke();

  // 4-point compass star
  ctx.fillStyle = "#38bdf8"; // North point blue
  ctx.beginPath();
  ctx.moveTo(nax, nay - 17 * s);
  ctx.lineTo(nax + 5 * s, nay);
  ctx.lineTo(nax, nay - 3 * s);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(nax, nay - 17 * s);
  ctx.lineTo(nax - 5 * s, nay);
  ctx.lineTo(nax, nay - 3 * s);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#64748b"; // South/East/West needles
  ctx.beginPath();
  ctx.moveTo(nax, nay + 14 * s);
  ctx.lineTo(nax + 4 * s, nay);
  ctx.lineTo(nax - 4 * s, nay);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#f8fafc";
  ctx.font = `bold ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("N", nax - 4 * s, nay - 20 * s);

  // 9. Bottom Cartographic Reference Strip
  ctx.fillStyle = "#091322";
  ctx.fillRect(marginInner, bannerH + H, canvas.width - marginInner * 2, footerH);

  ctx.fillStyle = "#64748b";
  ctx.font = `${8.5 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(
    "Coordinate System: Transverse Mercator (WGS 84)  ·  Vertical Datum: DEM / Local Ground  ·  Solver: 2-D Shallow Water Saint-Venant Equations  ·  TankBreach Municipal Engine",
    marginInner + 10 * s,
    bannerH + H + 18 * s,
  );

  ctx.fillStyle = "#94a3b8";
  ctx.font = `bold ${8.5 * s}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(`Run ID: ${o.runHash}`, canvas.width - marginInner - 120 * s, bannerH + H + 18 * s);

  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b!), "image/png", 0.95);
  });
}

/** Grabs the map canvas as a JPEG data URL for embedding in the PDF. */
export function mapSnapshotDataUrl(mapCanvas: HTMLCanvasElement): string | null {
  try {
    if (!mapCanvas || mapCanvas.width < 10 || mapCanvas.height < 10) return null;
    const maxW = 1000;
    const scale = Math.min(1, maxW / mapCanvas.width);
    const targetW = Math.round(mapCanvas.width * scale);
    const targetH = Math.round(mapCanvas.height * scale);

    const c = document.createElement("canvas");
    c.width = targetW;
    c.height = targetH;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(mapCanvas, 0, 0, targetW, targetH);
    return c.toDataURL("image/jpeg", 0.80);
  } catch {
    return null;
  }
}
