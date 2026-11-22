/** Minimal SVG chart primitives — no charting dependency, so the bundle stays small. */

export function LineChart({
  series,
  xLabel,
  yLabel,
  height = 100,
  colour = "#38bdf8",
  fill = "rgba(56,189,248,0.18)",
  marker,
}: {
  series: { x: number; y: number }[];
  xLabel?: string;
  yLabel?: string;
  height?: number;
  colour?: string;
  fill?: string;
  marker?: number;
}) {
  const w = 300;
  const h = height;
  const pad = { l: 34, r: 6, t: 8, b: 16 };
  const xs = series.map((p) => p.x);
  const ys = series.map((p) => p.y);
  const x0 = Math.min(...xs, 0);
  const x1 = Math.max(...xs, 1);
  const y0 = 0;
  const y1 = Math.max(...ys, 1e-9) * 1.08;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (w - pad.l - pad.r);
  const sy = (y: number) => h - pad.b - ((y - y0) / (y1 - y0 || 1)) * (h - pad.t - pad.b);
  const d = series.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const area = `${d} L${sx(series[series.length - 1]?.x ?? 0).toFixed(1)},${sy(0)} L${sx(series[0]?.x ?? 0).toFixed(1)},${sy(0)} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img">
      <line x1={pad.l} y1={sy(0)} x2={w - pad.r} y2={sy(0)} stroke="#2a3d5c" strokeWidth={1} />
      <path d={area} fill={fill} stroke="none" />
      <path d={d} fill="none" stroke={colour} strokeWidth={1.6} />
      {marker !== undefined && (
        <line x1={sx(marker)} y1={pad.t} x2={sx(marker)} y2={sy(0)} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" />
      )}
      <text x={pad.l - 4} y={pad.t + 8} fill="#93a4bd" fontSize={9} textAnchor="end">
        {y1.toPrecision(2)}
      </text>
      <text x={pad.l - 4} y={sy(0)} fill="#93a4bd" fontSize={9} textAnchor="end">
        0
      </text>
      {xLabel && (
        <text x={w - pad.r} y={h - 3} fill="#93a4bd" fontSize={9} textAnchor="end">
          {xLabel}
        </text>
      )}
      {yLabel && (
        <text x={2} y={10} fill="#93a4bd" fontSize={9}>
          {yLabel}
        </text>
      )}
    </svg>
  );
}

export function Histogram({
  values,
  height = 54,
  colour = "#38bdf8",
  maxValue,
}: {
  values: number[];
  height?: number;
  colour?: string;
  maxValue?: number;
}) {
  const w = 300;
  const h = height;
  const max = maxValue ?? Math.max(...values, 1);
  const bw = w / values.length;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {values.map((v, i) => {
        const bh = (v / max) * (h - 2);
        return <rect key={i} x={i * bw} y={h - bh} width={Math.max(1, bw - 0.5)} height={bh} fill={colour} opacity={0.85} />;
      })}
    </svg>
  );
}
