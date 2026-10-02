import { OBJECTIVE_LABELS, type Objective } from "@market/backtest/request";
import { cn, formatNumber, formatPercent, MISSING, Table, Td, Th } from "@market/ui";

interface Summary {
  totalReturn: number;
  cagr: number | null;
  sharpe: number | null;
  calmar: number | null;
  maxDrawdown: number;
  trades: number;
}
export interface SweepRow {
  values: Record<string, number>;
  summary: Summary | null;
  error: string | null;
}

export function objectiveValue(s: Summary | null, objective: Objective): number | null {
  if (!s) return null;
  switch (objective) {
    case "cagr":
      return s.cagr;
    case "sharpe":
      return s.sharpe;
    case "calmar":
      return s.calmar;
    case "total_return":
      return s.totalReturn;
  }
}

export const formatObjective = (v: number | null, objective: Objective) =>
  v === null
    ? MISSING
    : objective === "cagr" || objective === "total_return"
      ? formatPercent(v, 1)
      : formatNumber(v, 2);

const same = (a: Record<string, number>, b: Record<string, number> | null | undefined) =>
  !!b && Object.keys(a).every((k) => a[k] === b[k]);

/**
 * Parameter-sweep results (spec §5.15 "parameter-sweep heatmap"): a grid for two parameters, a
 * row for one, a ranked table for more. Shading is one hue by rank and every cell shows its
 * number, so nothing depends on color.
 */
export function SweepGrid({
  objective,
  params,
  rows,
  best,
}: {
  objective: Objective;
  params: Record<string, number[]>;
  rows: SweepRow[];
  best: Record<string, number> | null;
}) {
  const names = Object.keys(params).sort();
  const scores = rows
    .map((r) => objectiveValue(r.summary, objective))
    .filter((v): v is number => v !== null);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const shade = (v: number | null) =>
    v === null || !(hi > lo)
      ? undefined
      : `color-mix(in srgb, var(--primary) ${Math.round(8 + 42 * ((v - lo) / (hi - lo)))}%, transparent)`;
  const label = OBJECTIVE_LABELS[objective];

  const cell = (row: SweepRow | undefined, key?: number) => {
    const v = row ? objectiveValue(row.summary, objective) : null;
    const isBest = row ? same(row.values, best) : false;
    return (
      <Td
        key={key}
        numeric
        className={cn(
          "tabular-nums",
          isBest && "font-semibold outline-2 -outline-offset-2 outline-primary",
        )}
        style={{ backgroundColor: shade(v) }}
        title={row?.error ?? undefined}
      >
        {row?.error ? "error" : formatObjective(v, objective)}
        {isBest ? <span className="sr-only"> (best)</span> : null}
      </Td>
    );
  };

  if (names.length === 2) {
    const [a, b] = names as [string, string];
    const find = (x: number, y: number) => rows.find((r) => r.values[a] === x && r.values[b] === y);
    return (
      <Table
        aria-label={`${label} for each combination of ${a} and ${b}`}
        scrollLabel="Sweep grid, scrollable"
      >
        <thead>
          <tr>
            <Th>
              {a} ↓ / {b} →
            </Th>
            {params[b]!.map((y) => (
              <Th key={y} numeric>
                {y}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {params[a]!.map((x) => (
            <tr key={x}>
              <Th scope="row" className="border-b-0">
                {x}
              </Th>
              {params[b]!.map((y) => cell(find(x, y), y))}
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }

  if (names.length === 1) {
    const [a] = names as [string];
    return (
      <Table aria-label={`${label} for each value of ${a}`} scrollLabel="Sweep results, scrollable">
        <thead>
          <tr>
            <Th>{a}</Th>
            {params[a]!.map((x) => (
              <Th key={x} numeric>
                {x}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <Th scope="row">{label}</Th>
            {params[a]!.map((x) =>
              cell(
                rows.find((r) => r.values[a] === x),
                x,
              ),
            )}
          </tr>
        </tbody>
      </Table>
    );
  }

  const ranked = [...rows]
    .sort(
      (p, q) =>
        (objectiveValue(q.summary, objective) ?? -Infinity) -
        (objectiveValue(p.summary, objective) ?? -Infinity),
    )
    .slice(0, 50);
  return (
    <Table
      aria-label={`Combinations ranked by ${label}`}
      scrollLabel="Ranked combinations, scrollable"
    >
      <thead>
        <tr>
          {names.map((n) => (
            <Th key={n} numeric>
              {n}
            </Th>
          ))}
          <Th numeric>{label}</Th>
          <Th numeric>Max drawdown</Th>
          <Th numeric>Trades</Th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((r) => (
          <tr key={names.map((n) => r.values[n]).join("|")}>
            {names.map((n) => (
              <Td key={n} numeric className="tabular-nums">
                {r.values[n]}
              </Td>
            ))}
            {cell(r)}
            <Td numeric className="tabular-nums">
              {r.summary ? formatPercent(-r.summary.maxDrawdown, 1) : MISSING}
            </Td>
            <Td numeric className="tabular-nums">
              {r.summary?.trades ?? MISSING}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
