import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  fieldDef,
  parseScreen,
  PRESETS,
  runScreen,
  type FieldId,
  type ResultRow,
  type Screen,
} from "@market/screener";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
  Delta,
  EmptyState,
  formatCompact,
  formatDate,
  formatNumber,
  formatPercent,
  formatPrice,
  Input,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { ProviderId } from "@market/market-data";
import { ScreenBuilder } from "../../../components/screen-builder";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { assertDisplayable, sourceInfo } from "../../../server/market";
import { decodeScreen, encodeScreen, savedScreens } from "../../../server/screens";
import { deleteScreen, saveScreen } from "./actions";

export const metadata: Metadata = { title: "Screener" };

const PAGE_SIZE = 50;
const COLUMNS: FieldId[] = [
  "close",
  "change_1d",
  "return_1y",
  "market_cap",
  "pe",
  "dividend_yield",
  "rsi14",
];

type Search = Promise<Record<string, string | string[] | undefined>>;

function show(field: FieldId, v: string | number | null) {
  if (v === null || v === undefined) return <span className="text-muted-foreground">—</span>;
  const def = fieldDef(field);
  if (field === "change_1d") return <Delta fraction={Number(v)} />;
  switch (def.format) {
    case "price":
      return formatPrice(v);
    case "percent":
      return formatPercent(v);
    case "compact":
      return formatCompact(v);
    case "ratio":
      return formatNumber(v, 1);
    case "number":
      return formatNumber(v, 1);
    default:
      return String(v);
  }
}

/** Screener (Phase 1 step F3): presets, saved screens, a filter builder and paged results. */
export default async function ScreenerPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const saved = await savedScreens();
  const savedSel = saved.find((s) => s.id === one("saved"));
  const preset = PRESETS.find((p) => p.id === one("preset"));
  const screen: Screen =
    savedSel?.screen ?? preset?.screen ?? decodeScreen(one("s")) ?? parseScreen({});
  const title = savedSel?.name ?? preset?.name ?? (one("s") ? "Custom screen" : "All securities");
  const page = Math.max(1, Number(one("page")) || 1);

  const database = db();
  const { rows, total } = await runScreen(database, screen, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const meta = await database
    .selectFrom("market.screener_snapshot")
    .select((eb) => [
      eb.fn.max("as_of").as("asOf"),
      eb.fn.max("refreshed_at").as("refreshed"),
      eb.fn.max("source").as("source"),
    ])
    .executeTakeFirst();
  const source = meta?.source ? ProviderId.parse(meta.source) : null;
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);

  const columns = COLUMNS.includes(screen.sort.field) ? COLUMNS : [...COLUMNS, screen.sort.field];
  const link = (patch: { sort?: Screen["sort"]; page?: number }) => {
    const next: Screen = { ...screen, sort: patch.sort ?? screen.sort };
    const params = new URLSearchParams({ s: encodeScreen(next) });
    if (patch.page && patch.page > 1) params.set("page", String(patch.page));
    return `/screener?${params.toString()}`;
  };
  const sortLink = (field: FieldId) =>
    link({
      sort: {
        field,
        dir: screen.sort.field === field && screen.sort.dir === "desc" ? "asc" : "desc",
      },
    });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Screener</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Screens filter the data by the conditions you set. They are not recommendations.
        </p>
      </div>

      <div className="grid gap-6 2xl:grid-cols-[18rem_1fr]">
        <aside className="grid content-start gap-4 sm:grid-cols-2 2xl:grid-cols-1">
          <Card>
            <CardHeader title="Presets" />
            <CardContent className="pt-2">
              <ul className="flex flex-col gap-1 text-sm">
                {PRESETS.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/screener?preset=${p.id}`}
                      aria-current={preset?.id === p.id ? "page" : undefined}
                      title={p.description}
                      className={cn(
                        "block rounded-md px-2 py-1.5 hover:bg-muted",
                        preset?.id === p.id && "bg-muted font-medium",
                      )}
                    >
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader title="Saved screens" />
            <CardContent className="flex flex-col gap-3 pt-2">
              {saved.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. Save the current screen below.
                </p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {saved.map((s) => (
                    <li key={s.id} className="flex items-center gap-1">
                      <Link
                        href={`/screener?saved=${s.id}`}
                        aria-current={savedSel?.id === s.id ? "page" : undefined}
                        className={cn(
                          "flex-1 rounded-md px-2 py-1.5 hover:bg-muted",
                          savedSel?.id === s.id && "bg-muted font-medium",
                        )}
                      >
                        {s.name}
                      </Link>
                      <form action={deleteScreen}>
                        <input type="hidden" name="id" value={s.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${s.name}`}
                        >
                          Delete
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              <form id="save-screen" action={saveScreen} className="flex gap-2">
                <Input
                  name="name"
                  placeholder="Name"
                  aria-label="Screen name"
                  required
                  maxLength={100}
                />
                <Button type="submit">Save</Button>
              </form>
            </CardContent>
          </Card>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title={title} description="All conditions must hold." />
            <CardContent>
              <ScreenBuilder key={JSON.stringify(screen)} initial={screen} />
            </CardContent>
          </Card>

          {!meta?.asOf ? (
            <EmptyState title="No screener data yet">
              The snapshot is rebuilt after each close. Run <code>pnpm worker screener</code> to
              build it now.
            </EmptyState>
          ) : (
            <Card>
              <CardHeader
                title={`${total.toLocaleString("en-US")} ${total === 1 ? "match" : "matches"}`}
                description={
                  source ? (
                    <DataLabel
                      source={sourceInfo(source)}
                      kind="eod"
                      asOf={meta.asOf}
                      fetchedAt={meta.refreshed ? new Date(meta.refreshed) : null}
                    />
                  ) : null
                }
              />
              <CardContent>
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Screen results"
                  className="overflow-x-auto"
                >
                  <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">
                      {title}: {total} matches, page {page} of {pages}
                    </caption>
                    <thead>
                      <tr>
                        {(["ticker", "name", "sector"] as FieldId[]).concat(columns).map((f) => {
                          const active = screen.sort.field === f;
                          const numeric = fieldDef(f).type === "number";
                          return (
                            <th
                              key={f}
                              scope="col"
                              aria-sort={
                                active
                                  ? screen.sort.dir === "asc"
                                    ? "ascending"
                                    : "descending"
                                  : undefined
                              }
                              className={cn(
                                "border-b px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground",
                                numeric ? "text-right" : "text-left",
                                f === "name" && "hidden 2xl:table-cell",
                                f === "sector" && "hidden md:table-cell",
                              )}
                            >
                              <Link href={sortLink(f)} className="hover:text-foreground">
                                {fieldDef(f).label}
                                {active ? (screen.sort.dir === "asc" ? " ↑" : " ↓") : ""}
                              </Link>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: ResultRow) => (
                        <tr key={String(r.security_id)}>
                          <td className="border-b border-border/60 px-3 py-1.5">
                            <Link
                              href={`/stocks/${encodeURIComponent(String(r.ticker))}`}
                              className="font-mono font-medium text-primary hover:underline"
                            >
                              {r.ticker}
                            </Link>
                            {r.as_of !== meta.asOf ? (
                              <span className="block text-xs text-warning">
                                as of {formatDate(String(r.as_of))}
                              </span>
                            ) : null}
                          </td>
                          <td className="hidden max-w-64 truncate border-b border-border/60 px-3 py-1.5 text-muted-foreground 2xl:table-cell">
                            {r.name}
                          </td>
                          <td className="hidden border-b border-border/60 px-3 py-1.5 whitespace-nowrap text-muted-foreground md:table-cell">
                            {r.sector ?? "—"}
                          </td>
                          {columns.map((f) => (
                            <td
                              key={f}
                              className="border-b border-border/60 px-3 py-1.5 text-right whitespace-nowrap"
                            >
                              {show(f, r[f as keyof ResultRow] ?? null)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <nav aria-label="Pages" className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {total === 0
                      ? "No matches."
                      : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total.toLocaleString("en-US")}`}
                  </span>
                  <span className="flex gap-2">
                    {page > 1 ? (
                      <Link href={link({ page: page - 1 })} className="underline">
                        Previous
                      </Link>
                    ) : null}
                    {page < pages ? (
                      <Link href={link({ page: page + 1 })} className="underline">
                        Next
                      </Link>
                    ) : null}
                  </span>
                </nav>
                <p className="mt-3 text-xs text-muted-foreground">
                  Returns are total returns from split- and dividend-adjusted closes. Market cap
                  uses shares outstanding from the latest SEC filing; P/E, P/S and P/B use trailing
                  twelve months from SEC filings and are blank when earnings, sales or equity are
                  not positive or not reported.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
