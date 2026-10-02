import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  Card,
  CardContent,
  CardHeader,
  formatCompact,
  formatDate,
  formatPrice,
  Table,
  Td,
  Th,
} from "@market/ui";
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
import { drawingsFor } from "../../../../server/drawings";
import { flagEnabled } from "../../../../server/flags";
import { securityForTicker, tickerOf } from "../../../../server/stock";
import {
  assertDisplayable,
  lastUpdated,
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

/** Chart tab: the interactive chart and recent sessions (the header is in the layout). */
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
  const security = await securityForTicker(ticker);
  if (!security) notFound();

  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const [bars, updated] = source
    ? await Promise.all([
        recentBars(database, security.securityId, source, 10),
        lastUpdated(database, source),
      ])
    : [[], null];
  const drawings = (await flagEnabled("drawings")) ? await drawingsFor(security.securityId) : null;
  const info = source ? sourceInfo(source) : null;

  return (
    <div className="flex flex-col gap-6">
      {bars.length > 0 ? (
        <StockChart ticker={security.ticker} initial={initial} drawings={drawings} />
      ) : null}

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
