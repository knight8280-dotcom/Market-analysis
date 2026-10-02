import { formatDate, formatPercent } from "@market/ui";

const W = 800;
const H = 240;
const PAD = { r: 12, t: 12, b: 24 };

function path(
  values: readonly (number | null)[],
  y: (v: number) => number,
  x: (i: number) => number,
) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/**
 * Cumulative return of a portfolio or a backtest against its benchmark (a static SVG; the
 * summary above it carries the same numbers for screen readers).
 */
export function PerformanceChart({
  dates,
  portfolio,
  benchmark,
  benchmarkLabel,
  label = "Portfolio",
  legend = "Portfolio (time-weighted)",
}: {
  dates: readonly string[];
  /** Growth of 1. */
  portfolio: readonly number[];
  benchmark: readonly (number | null)[] | null;
  benchmarkLabel: string | null;
  /** Name of the main series in the accessible summary, and its legend entry. */
  label?: string;
  legend?: string;
}) {
  if (dates.length < 2) return null;
  const all = [...portfolio, ...(benchmark ?? []).filter((v): v is number => v !== null)].map(
    (v) => v - 1,
  );
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (hi - lo < 0.01) {
    hi += 0.005;
    lo -= 0.005;
  }
  // 0% when in range, then top, bottom and middle, skipping any that would crowd a label.
  const ticks: number[] = [];
  for (const t of [...(lo < 0 && hi > 0 ? [0] : []), hi, lo, (lo + hi) / 2]) {
    if (ticks.every((k) => Math.abs(k - t) > (hi - lo) * 0.12)) ticks.push(t);
  }
  // Room for the longest axis label (about 7 units per character at this size).
  const left = Math.max(44, Math.max(...ticks.map((t) => formatPercent(t, 1).length)) * 7 + 10);
  const x = (i: number) => left + (i / (dates.length - 1)) * (W - left - PAD.r);
  const y = (v: number) => PAD.t + ((hi - (v - 1)) / (hi - lo)) * (H - PAD.t - PAD.b);
  const last = portfolio.at(-1)! - 1;
  const benchLast = benchmark?.at(-1);
  const summary = `${label} ${formatPercent(last)} from ${formatDate(dates[0])} to ${formatDate(dates.at(-1))}${
    benchmark && benchmarkLabel && typeof benchLast === "number"
      ? `; ${benchmarkLabel} ${formatPercent(benchLast - 1)}`
      : ""
  }.`;
  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Cumulative return. ${summary}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={W - PAD.r}
              y1={y(t + 1)}
              y2={y(t + 1)}
              className="stroke-border"
              strokeDasharray={Math.abs(t) < 1e-12 ? undefined : "3 4"}
            />
            <text
              x={left - 6}
              y={y(t + 1) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px]"
            >
              {formatPercent(t, 1)}
            </text>
          </g>
        ))}
        <text x={left} y={H - 6} className="fill-muted-foreground text-[11px]">
          {formatDate(dates[0])}
        </text>
        <text
          x={W - PAD.r}
          y={H - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[11px]"
        >
          {formatDate(dates.at(-1))}
        </text>
        {benchmark ? (
          <path
            d={path(benchmark, y, x)}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            className="stroke-muted-foreground"
          />
        ) : null}
        <path d={path(portfolio, y, x)} fill="none" strokeWidth={2} className="stroke-primary" />
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-5 bg-primary" /> {legend}
        </span>
        {benchmark && benchmarkLabel ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block w-5 border-t-2 border-dashed border-muted-foreground"
            />
            {benchmarkLabel} (total return)
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
