import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  Delta,
  formatCompact,
  formatDate,
  formatPrice,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StockChart, type ChartSettings } from "../../../../components/chart/stock-chart";
import {
  DEFAULT_INDICATORS,
  INDICATOR_IDS,
  TIMEFRAMES,
  type Timeframe,
} from "../../../../lib/chart/catalog";
import { requireOwner } from "../../../../server/auth/owner";
import { db } from "../../../../server/db";
import {
  assertDisplayable,
  findSecurity,
  lastUpdated,
  latestQuotes,
  priceSource,
  recentBars,
  sourceInfo,
} from "../../../../server/market";

type Params = Promise<{ ticker: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

function chartSettings(q: Record<string, string | string[] | undefined>): ChartSettings {
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const tf = one("tf")?.toUpperCase();
  const ind = one("ind");
  return {
    tf: (TIMEFRAMES as readonly string[]).includes(tf ?? "") ? (tf as Timeframe) : "1Y",
    indicators:
      ind === undefined ? DEFAULT_INDICATORS : ind.split(",").filter((id) => INDICATOR_IDS.has(id)),
    adjusted: one("adj") !== "0",
    type: one("type") === "line" ? "line" : "candles",
  };
}

function tickerOf(raw: string): string {
  return decodeURIComponent(raw).trim().toUpperCase();
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: tickerOf((await params).ticker) };
}

/** Ticker page: header with the latest bar, the interactive chart and recent sessions. */
export default async function StockPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  const ticker = tickerOf((await params).ticker);
  const initial = chartSettings(await searchParams);
  const database = db();
  const security = await findSecurity(database, ticker);
  if (!security) notFound();

  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const [quote, bars, updated] = source
    ? await Promise.all([
        latestQuotes(database, source, { securityIds: [security.securityId] }).then((q) => q[0]),
        recentBars(database, security.securityId, source, 10),
        lastUpdated(database, source),
      ])
    : [undefined, [], null];
  const info = source ? sourceInfo(source) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{security.ticker}</h1>
            {security.assetClass !== "equity" ? (
              <Badge>{security.assetClass.toUpperCase()}</Badge>
            ) : null}
            {!security.active ? (
              <Badge tone="warning">
                Delisted{security.delistedAt ? ` ${formatDate(security.delistedAt)}` : ""}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-muted-foreground">{security.name}</p>
          {security.sector ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {security.sicCode ? "Sector (SEC SIC)" : "Sector"}: {security.sector}
              {security.industry ? ` · ${security.industry}` : ""}
            </p>
          ) : null}
        </div>
        {quote && info ? (
          <div className="text-right">
            <p className="text-3xl font-semibold">{formatPrice(quote.close, security.currency)}</p>
            <p className="text-lg">
              <Delta fraction={quote.change} />
            </p>
            <DataLabel
              source={info}
              kind="eod"
              asOf={quote.date}
              fetchedAt={updated?.loadedAt ?? null}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No prices for this security yet.</p>
        )}
      </header>

      {bars.length > 0 ? <StockChart ticker={security.ticker} initial={initial} /> : null}

      {bars.length > 0 && info ? (
        <Card>
          <CardHeader
            title="Recent sessions"
            description={
              <DataLabel
                source={info}
                kind="eod"
                asOf={bars[0]!.date}
                fetchedAt={updated?.loadedAt ?? null}
              />
            }
          />
          <CardContent>
            <Table>
              <caption className="sr-only">
                Daily bars for {security.ticker}, newest first, as reported (not adjusted)
              </caption>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th numeric>Open</Th>
                  <Th numeric>High</Th>
                  <Th numeric>Low</Th>
                  <Th numeric>Close</Th>
                  <Th numeric>Volume</Th>
                </tr>
              </thead>
              <tbody>
                {bars.map((b) => (
                  <tr key={b.date}>
                    <Td>{formatDate(b.date)}</Td>
                    <Td numeric>{formatPrice(b.open, security.currency)}</Td>
                    <Td numeric>{formatPrice(b.high, security.currency)}</Td>
                    <Td numeric>{formatPrice(b.low, security.currency)}</Td>
                    <Td numeric>{formatPrice(b.close, security.currency)}</Td>
                    <Td numeric>{formatCompact(b.volume)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
