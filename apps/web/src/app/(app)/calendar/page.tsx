import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  cn,
  EmptyState,
  formatDate,
  formatNumber,
} from "@market/ui";
import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireOwner } from "../../../server/auth/owner";
import { actionsBetween, earningsBetween, releasesBetween } from "../../../server/calendars";
import { CALENDAR_TABS, calendarWindow, type CalendarTab } from "../../../server/calendar-view";
import { db } from "../../../server/db";
import { assertDisplayable, priceSource, sourceInfo } from "../../../server/market";

export const metadata: Metadata = { title: "Calendar" };

const LABEL: Record<CalendarTab, string> = {
  earnings: "Earnings",
  economic: "Economic releases",
  actions: "Dividends and splits",
};
const HOUR: Record<string, string> = {
  bmo: "Before open",
  amc: "After close",
  dmh: "During market",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b px-3 py-2 text-xs font-medium text-muted-foreground",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  right,
  className,
}: {
  children: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={cn("border-b border-border/60 px-3 py-1.5", right && "text-right", className)}>
      {children}
    </td>
  );
}

/** Calendars (Phase 1 step H2): earnings, economic releases, dividends and splits; .ics export. */
export default async function CalendarPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const tab = (CALENDAR_TABS as readonly string[]).includes(String(q.tab))
    ? (q.tab as CalendarTab)
    : "earnings";
  const majorOnly = q.all !== "1";
  const { from, to } = calendarWindow(tab);
  const database = db();
  const appEnv = loadWebEnv().APP_ENV;

  let body: React.ReactNode;
  let label: React.ReactNode = null;
  if (tab === "earnings") {
    const rows = await earningsBetween(database, from, to);
    const sources = new Set(rows.map((r) => r.source));
    if (sources.has("finnhub")) assertDisplayable("finnhub", "earnings", appEnv);
    label = (
      <span className="flex flex-col gap-1">
        {sources.has("finnhub") ? (
          <DataLabel source={sourceInfo("finnhub")} kind="observation" asOf={null} />
        ) : null}
        {sources.has("sec_edgar") ? (
          <DataLabel source={sourceInfo("sec_edgar")} kind="filing" asOf={null} />
        ) : null}
      </span>
    );
    body =
      rows.length === 0 ? (
        <EmptyState title="No earnings in this window">
          Upcoming dates need a Finnhub key (FINNHUB_API_KEY); without it, past report dates come
          from 8-K Item 2.02 filings once SEC data is loaded.
        </EmptyState>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Earnings from {formatDate(from)} to {formatDate(to)}
          </caption>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Ticker</Th>
              <Th>When</Th>
              <Th>Period</Th>
              <Th right>EPS estimate</Th>
              <Th right>EPS actual</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.ticker}-${r.date}-${r.source}`}>
                <Td className="whitespace-nowrap">{formatDate(r.date)}</Td>
                <Td>
                  <Link
                    href={`/stocks/${encodeURIComponent(r.ticker)}`}
                    className="font-mono font-medium text-primary hover:underline"
                  >
                    {r.ticker}
                  </Link>
                  {r.onWatchlist ? (
                    <Badge className="ml-2" tone="info">
                      Watchlist
                    </Badge>
                  ) : null}
                </Td>
                <Td>{r.hour ? HOUR[r.hour] : "—"}</Td>
                <Td>
                  {r.fiscalQuarter && r.fiscalYear ? `Q${r.fiscalQuarter} ${r.fiscalYear}` : "—"}
                </Td>
                <Td right>{r.epsEstimate ? formatNumber(r.epsEstimate, 2) : "—"}</Td>
                <Td right>{r.epsActual ? formatNumber(r.epsActual, 2) : "—"}</Td>
                <Td className="text-xs text-muted-foreground">
                  {r.source === "finnhub" ? "Finnhub" : "SEC 8-K Item 2.02"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  } else if (tab === "economic") {
    const all = await releasesBetween(database, from, to);
    const rows = majorOnly ? all.filter((r) => r.major) : all;
    label = <DataLabel source={sourceInfo("fred")} kind="observation" asOf={null} />;
    body = (
      <>
        <p className="mb-2 text-sm">
          {majorOnly ? (
            <Link href="/calendar?tab=economic&all=1" className="underline">
              Show all {all.length} releases
            </Link>
          ) : (
            <Link href="/calendar?tab=economic" className="underline">
              Show major releases only
            </Link>
          )}
        </p>
        {rows.length === 0 ? (
          <EmptyState title="No releases in this window">
            Release dates come from FRED (FRED_ENABLED and a free FRED_API_KEY).
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Economic releases from {formatDate(from)} to {formatDate(to)}
            </caption>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Release</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.releaseId}-${r.date}`}>
                  <Td className="whitespace-nowrap">{formatDate(r.date)}</Td>
                  <Td>
                    {r.name}
                    {r.major ? (
                      <Badge className="ml-2" tone="info">
                        Major
                      </Badge>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  } else {
    const source = await priceSource(database);
    const rows = source ? await actionsBetween(database, source, from, to) : [];
    if (source) {
      assertDisplayable(source, "corporate_actions", appEnv);
      label = <DataLabel source={sourceInfo(source)} kind="eod" asOf={to} />;
    }
    body =
      rows.length === 0 ? (
        <EmptyState title="No dividends or splits in the last 60 days" />
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Corporate actions from {formatDate(from)} to {formatDate(to)}
          </caption>
          <thead>
            <tr>
              <Th>Ex-date</Th>
              <Th>Ticker</Th>
              <Th>Type</Th>
              <Th right>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ticker}-${r.date}-${r.type}-${i}`}>
                <Td className="whitespace-nowrap">{formatDate(r.date)}</Td>
                <Td>
                  <Link
                    href={`/stocks/${encodeURIComponent(r.ticker)}`}
                    className="font-mono font-medium text-primary hover:underline"
                  >
                    {r.ticker}
                  </Link>
                </Td>
                <Td>{r.type.replaceAll("_", " ")}</Td>
                <Td right>
                  {r.cashAmount
                    ? `$${formatNumber(r.cashAmount, 4).replace(/0{1,2}$/, "")}`
                    : r.ratio
                      ? `${Number(r.ratio) >= 1 ? `${Number(r.ratio)}:1` : `1:${Number((1 / Number(r.ratio)).toFixed(4))}`}`
                      : "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(from)} to {formatDate(to)}
          </p>
        </div>
        <a
          href={`/api/calendar?tab=${tab}${majorOnly ? "" : "&all=1"}`}
          className="flex min-h-9 items-center gap-2 rounded-md border px-3.5 text-sm hover:bg-muted"
        >
          <Download aria-hidden className="size-4" />
          Download .ics
        </a>
      </div>
      <nav aria-label="Calendars" className="flex gap-1 border-b">
        {CALENDAR_TABS.map((t) => (
          <Link
            key={t}
            href={`/calendar?tab=${t}`}
            aria-current={t === tab ? "page" : undefined}
            className={cn(
              "-mb-px flex min-h-9 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground",
              t === tab && "border-primary font-medium text-foreground",
            )}
          >
            {LABEL[t]}
          </Link>
        ))}
      </nav>
      <Card>
        <CardHeader title={LABEL[tab]} description={label} />
        <CardContent>
          <div tabIndex={0} role="region" aria-label={LABEL[tab]} className="overflow-x-auto">
            {body}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
