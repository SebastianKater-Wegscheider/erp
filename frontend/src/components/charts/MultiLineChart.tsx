import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";

type Datum = { x: string; [key: string]: number | string };

export type MultiLineSeries = {
  key: string;
  label: string;
  stroke: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function MultiLineChart({
  data,
  series,
  height = 180,
  className,
  valueFormatter = (v) => formatCompactNumber(v),
  xFormatter = (x) => x,
  ariaLabel = "Chart",
}: {
  data: Datum[];
  series: MultiLineSeries[];
  height?: number;
  className?: string;
  valueFormatter?: (v: number) => string;
  xFormatter?: (x: string) => string;
  ariaLabel?: string;
}) {
  const W = 640;
  const H = 220;
  const padX = 14;
  const padY = 14;
  const n = data.length;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { minY, maxY } = useMemo(() => {
    const values: number[] = [];
    for (const d of data) {
      for (const s of series) values.push(Number(d[s.key]) || 0);
    }
    if (values.length === 0) return { minY: 0, maxY: 1 };
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const bump = Math.max(1, Math.abs(min) * 0.1);
      min -= bump;
      max += bump;
    }
    return { minY: min, maxY: max };
  }, [data, series]);

  const plotW = W - padX * 2;
  const plotH = H - padY * 2;

  const xAt = (idx: number) => (n <= 1 ? padX + plotW / 2 : padX + (idx * plotW) / (n - 1));
  const yAt = (v: number) => padY + ((maxY - v) / (maxY - minY)) * plotH;

  const hover = hoverIdx === null ? null : data[clamp(hoverIdx, 0, Math.max(0, n - 1))];
  const last = data.length ? data[data.length - 1] : null;
  const tooltip = hover ?? last;

  const gridLines: number = 3;
  const grid = Array.from({ length: gridLines }, (_, i) => i);
  const hasZero = minY < 0 && maxY > 0;
  const y0 = hasZero ? yAt(0) : null;

  return (
    <div className={cn("relative", className)}>
      {tooltip && (
        <div className="pointer-events-none absolute right-0 top-0 z-10 rounded-md border border-gray-200 bg-white/90 px-2 py-1 text-xs text-gray-700 shadow-sm backdrop-blur dark:border-gray-800 dark:bg-gray-950/70 dark:text-gray-200">
          <div className="font-medium text-gray-900 dark:text-gray-100">{xFormatter(String(tooltip.x))}</div>
          <div className="mt-1 space-y-0.5">
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.stroke }} />
                  <span>{s.label}</span>
                </div>
                <div className="font-medium">{valueFormatter(Number(tooltip[s.key]) || 0)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${W} ${H}`}
        style={{ height }}
        className="w-full"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const svg = e.currentTarget;
          const rect = svg.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const t = clamp((px - padX) / Math.max(1, plotW), 0, 1);
          const idx = Math.round(t * Math.max(0, n - 1));
          setHoverIdx(idx);
        }}
      >
        <rect x={0} y={0} width={W} height={H} fill="transparent" />

        {grid.map((i) => {
          const t = gridLines === 1 ? 0 : i / (gridLines - 1);
          const y = padY + t * plotH;
          const v = maxY - t * (maxY - minY);
          return (
            <g key={i}>
              <line x1={padX} y1={y} x2={padX + plotW} y2={y} stroke="currentColor" strokeOpacity={0.08} />
              <text x={padX} y={y - 4} fontSize={10} fill="currentColor" opacity={0.35}>
                {valueFormatter(v)}
              </text>
            </g>
          );
        })}

        {y0 !== null && (
          <line x1={padX} y1={y0} x2={padX + plotW} y2={y0} stroke="currentColor" strokeOpacity={0.25} />
        )}

        {series.map((s) => {
          const d = data
            .map((p, i) => {
              const x = xAt(i);
              const y = yAt(Number(p[s.key]) || 0);
              return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(" ");
          return (
            <path
              key={s.key}
              d={d}
              fill="none"
              stroke={s.stroke}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {hoverIdx !== null && n > 0 && (
          <>
            <line
              x1={xAt(hoverIdx)}
              y1={padY}
              x2={xAt(hoverIdx)}
              y2={padY + plotH}
              stroke="currentColor"
              strokeOpacity={0.18}
            />
            {series.map((s) => {
              const p = data[clamp(hoverIdx, 0, n - 1)];
              const x = xAt(hoverIdx);
              const y = yAt(Number(p[s.key]) || 0);
              return (
                <g key={s.key}>
                  <circle cx={x} cy={y} r={4} fill={s.stroke} />
                  <circle cx={x} cy={y} r={6} fill={s.stroke} opacity={0.15} />
                </g>
              );
            })}
          </>
        )}
      </svg>
    </div>
  );
}
