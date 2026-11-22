/**
 * Legend card embedded in the damage KMZ (as a KML ScreenOverlay) and used by the PDF/PNG
 * reports. Rendered on a canvas here rather than in KML `<ScreenOverlay>` markup because KML
 * cannot draw a key table on its own, and a legend that lives in the same file as the polygons
 * cannot get separated from them.
 */
import { DAMAGE_COLOURS } from "../analysis/impact";
import type { SimulationResult } from "../engine/types";

export function damageLegendPng(result: SimulationResult, areaKm2: number): string | null {
  const W = 360;
  const H = 260;
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(2, 2);

  // Background Card
  ctx.fillStyle = "rgba(11, 21, 40, 0.95)";
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.5;
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(r, 1);
  ctx.arcTo(W - 1, 1, W - 1, H - 1, r);
  ctx.arcTo(W - 1, H - 1, 1, H - 1, r);
  ctx.arcTo(1, H - 1, 1, 1, r);
  ctx.arcTo(1, 1, W - 1, 1, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Top header accent strip
  ctx.fillStyle = "#0284c7";
  ctx.fillRect(1, 1, W - 2, 3);

  // Header Title
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 13px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("MUNICIPAL HAZARD LEGEND", 14, 24);

  ctx.fillStyle = "#64748b";
  ctx.fillRect(14, 31, W - 28, 1);

  // Hazard bands (USBR / FEMA standard)
  const hazardItems = [
    { label: "High Hazard (>0.5 m / extreme)", colour: "#dc2626" },
    { label: "Medium Hazard (0.15–0.5 m / vehicle)", colour: "#fb923c" },
    { label: "Low Hazard (<0.15 m / sheet flow)", colour: "#facc15" },
  ];

  let y = 52;
  ctx.font = "11px ui-sans-serif, system-ui, -apple-system, sans-serif";
  for (const item of hazardItems) {
    ctx.fillStyle = item.colour;
    ctx.fillRect(14, y - 10, 24, 13);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(14, y - 10, 24, 13);

    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(item.label, 46, y);
    y += 22;
  }

  // Symbology divider
  y += 2;
  ctx.fillStyle = "#64748b";
  ctx.fillRect(14, y - 8, W - 28, 1);

  // 1. Storage tank
  y += 14;
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.arc(26, y - 4, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText("Storage tank location (origin)", 48, y);

  // 2. Inundation boundary (flood perimeter line)
  y += 22;
  ctx.beginPath();
  ctx.moveTo(14, y - 4);
  ctx.bezierCurveTo(22, y - 10, 28, y + 2, 36, y - 4);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = "#0a0f1d";
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillText("Inundation boundary (flood perimeter)", 48, y);

  // Summary footer strip
  y += 18;
  ctx.fillStyle = "#64748b";
  ctx.fillRect(14, y - 6, W - 28, 1);
  y += 12;

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 10.5px ui-sans-serif, system-ui, -apple-system, sans-serif";
  const affHa = (result.stats.affectedAreaM2 / 10000).toFixed(2);
  ctx.fillText(`Inundated Area: ${affHa} ha · Max Depth: ${result.stats.maxDepthM.toFixed(2)} m`, 14, y);

  y += 14;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "9.5px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.fillText("ArcGIS Pro Aligned Municipal Screening Study", 14, y);

  return canvas.toDataURL("image/png");
}
