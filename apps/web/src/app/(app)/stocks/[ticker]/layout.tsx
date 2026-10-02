import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import { Badge, Delta, formatDate, formatPrice } from "@market/ui";
import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { StockTabs } from "../../../../components/stock-tabs";
import { WatchlistMenu } from "../../../../components/watchlist-menu";
import { requireOwner } from "../../../../server/auth/owner";
import { db } from "../../../../server/db";
import {
  assertDisplayable,
  lastUpdated,
  latestQuotes,
  priceSource,
  sourceInfo,
} from "../../../../server/market";
import { flagEnabled } from "../../../../server/flags";
import { securityForTicker, tickerOf } from "../../../../server/stock";

type Params = Promise<{ ticker: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: tickerOf((await params).ticker) };
}

/** Ticker header (latest bar, change, source and as-of) and the Chart / Financials tabs. */
export default async function StockLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Params;
}) {
  await requireOwner();
  const ticker = tickerOf((await params).ticker);
  const security = await securityForTicker(ticker);
  if (!security) notFound();
  const database = db();
  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const [quote, updated] = source
    ? await Promise.all([
        latestQuotes(database, source, { securityIds: [security.securityId] }).then((q) => q[0]),
        lastUpdated(database, source),
      ])
    : [undefined, null];
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
          <div className="mt-2 flex flex-wrap gap-2">
            <WatchlistMenu securityId={security.securityId} ticker={security.ticker} />
            <Link
              href={`/alerts?ticker=${encodeURIComponent(security.ticker)}`}
              className="flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-sm hover:bg-muted"
            >
              <Bell aria-hidden className="size-3.5" />
              Alert
            </Link>
          </div>
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
      <StockTabs ticker={security.ticker} valuation={await flagEnabled("valuation")} />
      {children}
    </div>
  );
}
