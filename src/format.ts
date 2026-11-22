/** Formatting helpers. Every number that reaches the UI carries a unit. */

export const fmtVolume = (m3: number): string => {
  if (!Number.isFinite(m3)) return "—";
  if (Math.abs(m3) >= 1e6) return `${(m3 / 1e6).toFixed(2)} Mm³`;
  if (Math.abs(m3) >= 1e3) return `${m3.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³`;
  return `${m3.toFixed(1)} m³`;
};

export const fmtRate = (m3s: number): string => {
  if (!Number.isFinite(m3s)) return "—";
  if (Math.abs(m3s) < 0.001) return `${(m3s * 1000).toFixed(2)} L/s`;
  if (Math.abs(m3s) < 1) return `${(m3s * 1000).toFixed(0)} L/s (${m3s.toFixed(3)} m³/s)`;
  return `${m3s.toFixed(2)} m³/s`;
};

export const fmtArea = (m2: number): string => {
  if (!Number.isFinite(m2)) return "—";
  const ha = m2 / 10000;
  if (ha >= 100) return `${(ha / 100).toFixed(2)} km² (${ha.toFixed(0)} ha)`;
  if (ha >= 1) return `${ha.toFixed(2)} ha`;
  return `${m2.toFixed(0)} m²`;
};

export const fmtLength = (m: number): string => {
  if (!Number.isFinite(m)) return "—";
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
};

export const fmtDepth = (m: number): string => {
  if (!Number.isFinite(m)) return "—";
  if (m < 0.01) return `${(m * 1000).toFixed(0)} mm`;
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  return `${m.toFixed(2)} m`;
};

export const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${s.toFixed(0)} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = Math.round(s - m * 60);
    return sec ? `${m} min ${sec} s` : `${m} min`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s - h * 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s - d * 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
};

/**
 * Human label for the release end point. "Time to empty" is only honest when the tank
 * actually emptied; a weir keeps spilling until the head reaches the invert.
 */
export const fmtReleaseTime = (s: number, stopReason?: string): string =>
  stopReason === "empty" ? fmtTime(s) : `${fmtTime(s)} (not emptied)`;

export const fmtSpeed = (v: number): string => `${v.toFixed(2)} m/s`;

export const fmtCoord = (n: number, digits = 5): string => n.toFixed(digits);

export const timestamp = (d = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

export const humanDateTime = (d = new Date()): string => d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
