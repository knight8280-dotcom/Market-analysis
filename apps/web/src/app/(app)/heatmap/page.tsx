import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  Card,
  CardContent,
  CardHeader,
  cn,
  Delta,
  EmptyState,
  formatCompact,
  formatPercent,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { Heatmap } from "../../../components/heatmap";
import { groupTiles, weightedChange } from "../../../lib/heatmap/layout";
import { heatColor, HEATMAP_PERIODS } from "../../../lib/heatmap/scale";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { heatmapData, type HeatmapSet, type HeatmapSize } from "../../../server/heatmap";
import { assertDisplayable, sourceInfo } from "../../../server/market";

export const metadata: Metadata = { title: "Heatmap" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const SETS: { id: HeatmapSet; label: string }[] = [
  { id: "stocks", label: "Stocks by sector" },
  { id: "etfs", label: "ETFs" },
];
const SIZES: { id: HeatmapSize; label: string }[] = [
  { id: "cap", label: "Market cap" },
  { id: "dollar", label: "Dollar volume" },
];

function Segmented({
  label,
  options,
  selected,
  href,
}: {
  label: string;
  options: { id: string; label: string; disabled?: boolean }[];
  selected: string;
  href: (id: string) => string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1 text-sm">
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {options.map((o) =>
        o.disabled ? (
          <span
            key={o.id}
            aria-disabled
            className="flex min-h-8 items-center rounded-md px-2.5 text-muted-foreground/60"
          >
            {o.label}
          </span>
        ) : (
          <Link
            key={o.id}
            href={href(o.id)}
            aria-current={o.id === selected ? "page" : undefined}
            className={cn(
              "flex min-h-8 items-center rounded-md px-2.5 hover:bg-muted",
              o.id === selected && "bg-muted font-medium",
            )}
          >
            {o.label}
          </Link>
        ),
      )}
    </nav>
  );
}

/** Sector heatmap (Phase 1 step H3; spec §5.8). */
export default async function HeatmapPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const set: HeatmapSet = one("set") === "etfs" ? "etfs" : "stocks";
  const period = HEATMAP_PERIODS.find((p) => p.id === one("period")) ?? HEATMAP_PERIODS[0];
  const database = db();

  // Market cap needs SEC shares outstanding; without any, only dollar volume can size tiles.
  const requested = one("size");
  let size: HeatmapSize = requested === "dollar" ? "dollar" : "cap";
  let data = await heatmapData(database, set, period, size);
  if (size === "cap" && !data.anyMarketCap) {
    size = "dollar";
    data = await heatmapData(database, set, period, size);
  }
  if (data.source) assertDisplayable(data.source, "daily_bars", loadWebEnv().APP_ENV);

  const href = (patch: { set?: string; period?: string; size?: string }) => {
    const params = new URLSearchParams({
      set: patch.set ?? set,
      period: patch.period ?? period.id,
      size: patch.size ?? size,
    });
    return `/heatmap?${params.toString()}`;
  };
  const sizeLabel = size === "cap" ? "market cap" : "dollar volume (30-day average)";

  const sectors = [...groupTiles(data.tiles)]
    .map(([name, tiles]) => ({
      name,
      count: tiles.length,
      total: tiles.reduce((s, t) => s + t.size, 0),
      change: weightedChange(tiles),
    }))
    .sort((a, b) => b.total - a.total);
  const legend = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1].map((f) => f * period.full);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Heatmap</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The universe by sector (SIC-based, not GICS). Colors show change, not a recommendation.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Segmented
          label="Show"
          options={SETS}
          selected={set}
          href={(id) => href({ set: id, size: requested ?? "cap" })}
        />
        <Segmented
          label="Period"
          options={HEATMAP_PERIODS.map((p) => ({ id: p.id, label: p.label }))}
          selected={period.id}
          href={(id) => href({ period: id })}
        />
        <Segmented
          label="Size by"
          options={SIZES.map((s) => ({ ...s, disabled: s.id === "cap" && !data.anyMarketCap }))}
          selected={size}
          href={(id) => href({ size: id })}
        />
      </div>

      <Card>
        <CardHeader
          title={`${SETS.find((s) => s.id === set)!.label}: ${period.label}`}
          description={
            data.source && data.asOf ? (
              <DataLabel
                source={sourceInfo(data.source)}
                kind="eod"
                asOf={data.asOf}
                fetchedAt={data.refreshedAt}
              />
            ) : null
          }
        />
        <CardContent className="flex flex-col gap-3">
          {data.tiles.length === 0 ? (
            <EmptyState title="Nothing to show yet">
              The heatmap reads the screener snapshot, which the worker rebuilds after each
              end-of-day load (or run <code>pnpm worker screener</code>).
            </EmptyState>
          ) : (
            <>
              <Heatmap
                tiles={data.tiles}
                full={period.full}
                periodLabel={period.label}
                sizeLabel={sizeLabel}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <ol aria-label="Color scale" className="flex items-center gap-0.5">
                  {legend.map((v, i) => (
                    <li key={i} className="flex flex-col items-center gap-0.5">
                      <span
                        aria-hidden
                        className="block h-3 w-10"
                        style={{ backgroundColor: heatColor(v, period.full) }}
                      />
                      <span className="text-muted-foreground tabular-nums">
                        {i === 0 ? "≤ " : i === legend.length - 1 ? "≥ " : ""}
                        {formatPercent(v, 0)}
                      </span>
                    </li>
                  ))}
                </ol>
                {data.missingSize > 0 ? (
                  <p className="text-muted-foreground">
                    {data.missingSize} {data.missingSize === 1 ? "security" : "securities"} without
                    a {size === "cap" ? "market cap" : "volume history"} not shown.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {sectors.length > 0 ? (
        <Card>
          <CardHeader title="Sectors" description={`Weighted by ${sizeLabel}`} />
          <CardContent>
            <div tabIndex={0} role="region" aria-label="Sectors" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {[
                      "Sector",
                      "Securities",
                      size === "cap" ? "Market cap" : "Dollar volume",
                      "Change",
                    ].map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn(
                          "border-b px-3 py-2 text-xs font-medium text-muted-foreground",
                          i === 0 ? "text-left" : "text-right",
                          i === 1 && "hidden sm:table-cell",
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sectors.map((s) => (
                    <tr key={s.name}>
                      <td className="border-b border-border/60 px-3 py-1.5">{s.name}</td>
                      <td className="hidden border-b border-border/60 px-3 py-1.5 text-right tabular-nums sm:table-cell">
                        {s.count}
                      </td>
                      <td className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums">
                        {formatCompact(s.total)}
                      </td>
                      <td className="border-b border-border/60 px-3 py-1.5 text-right">
                        <Delta fraction={s.change} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
