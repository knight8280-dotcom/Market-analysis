import { formatDate, formatPercent } from "@market/ui";

const W = 800;
const H = 140;
const PAD = { l: 52, r: 12, t: 8, b: 22 };

/** Drawdown from the running peak, as a filled area below zero (static SVG with a summary). */
export function DrawdownChart({
  dates,
  drawdown,
}: {
  dates: readonly string[];
  /** 0 or negative fractions. */
  drawdown: readonly number[];
}) {
  if (dates.length < 2) return null;
  const lo = Math.min(-0.01, ...drawdown);
  const x = (i: number) => PAD.l + (i / (dates.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (v / lo) * (H - PAD.t - PAD.b);
  let worst = 0;
  drawdown.forEach((v, i) => {
    if (v < drawdown[worst]!) worst = i;
  });
  const line = drawdown.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `${line.join("")}L${x(dates.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const summary = `Largest drawdown ${formatPercent(drawdown[worst])} on ${formatDate(dates[worst])}.`;
  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Drawdown from the previous peak. ${summary}`}
      >
        {[0, lo].map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-border" />
            <text
              x={PAD.l - 6}
              y={y(t) + 4}
              textAnchor="end"
              className="fill-muted-foreground text-[11px]"
            >
              {formatPercent(t, 1)}
            </text>
          </g>
        ))}
        <path d={area} className="fill-down/20 stroke-down" strokeWidth={1} />
        <text x={PAD.l} y={H - 5} className="fill-muted-foreground text-[11px]">
          {formatDate(dates[0])}
        </text>
        <text
          x={W - PAD.r}
          y={H - 5}
          textAnchor="end"
          className="fill-muted-foreground text-[11px]"
        >
          {formatDate(dates.at(-1))}
        </text>
      </svg>
      <figcaption className="text-xs text-muted-foreground">{summary}</figcaption>
    </figure>
  );
}
