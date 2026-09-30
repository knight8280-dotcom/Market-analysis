import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  Card,
  CardContent,
  CardHeader,
  Delta,
  EmptyState,
  formatDate,
  formatPrice,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { recentAlertEvents } from "../../server/alerts";
import { requireOwner } from "../../server/auth/owner";
import { db } from "../../server/db";
import {
  assertDisplayable,
  lastUpdated,
  latestQuotes,
  movers,
  priceSource,
  sourceInfo,
  type Quote,
} from "../../server/market";
import { listWatchlists } from "../../server/watchlists";

export const metadata: Metadata = { title: "Markets" };

const INDEX_ETFS = ["SPY", "QQQ", "DIA", "IWM"];

/** Name only on the widest screens: two tables sit side by side next to the sidebar. */
function QuoteTable({ quotes, session }: { quotes: Quote[]; session: string }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Ticker</Th>
          <Th className="hidden 2xl:table-cell">Name</Th>
          <Th numeric>Close</Th>
          <Th numeric>Change</Th>
        </tr>
      </thead>
      <tbody>
        {quotes.map((q) => (
          <tr key={q.securityId}>
            <Td>
              <Link
                href={`/stocks/${encodeURIComponent(q.ticker)}`}
                className="font-mono font-medium text-primary hover:underline"
              >
                {q.ticker}
              </Link>
            </Td>
            <Td className="hidden max-w-64 truncate text-muted-foreground 2xl:table-cell">
              {q.name}
            </Td>
            <Td numeric>
              {formatPrice(q.close)}
              {/* A row from an older session says so (MUST DO #7). */}
              {q.date !== session ? (
                <span className="block text-xs text-warning">as of {formatDate(q.date)}</span>
              ) : null}
            </Td>
            <Td numeric>
              <Delta fraction={q.change} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function MarketsPage() {
  await requireOwner();
  const database = db();
  const source = await priceSource(database);
  if (!source) {
    return (
      <EmptyState title="No prices loaded yet">
        Run <code>pnpm worker bootstrap</code> to load the universe (see docs/RUNBOOK.md).
      </EmptyState>
    );
  }
  assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const updated = await lastUpdated(database, source);
  const session = updated.session!;
  const [indices, moves, lists, events] = await Promise.all([
    latestQuotes(database, source, { tickers: INDEX_ETFS }),
    movers(database, source, session),
    listWatchlists(),
    recentAlertEvents(5),
  ]);
  const label = (
    <DataLabel source={sourceInfo(source)} kind="eod" asOf={session} fetchedAt={updated.loadedAt} />
  );
  indices.sort((a, b) => INDEX_ETFS.indexOf(a.ticker) - INDEX_ETFS.indexOf(b.ticker));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Markets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Session of {formatDate(session)}. Press <kbd>/</kbd> or ⌘K to look up a ticker.
        </p>
      </div>
      {indices.length > 0 ? (
        <Card>
          <CardHeader title="Index ETFs" description={label} />
          <CardContent>
            <QuoteTable quotes={indices} session={session} />
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Your watchlists"
            action={
              <Link href="/watchlists" className="text-sm text-primary hover:underline">
                Open
              </Link>
            }
          />
          <CardContent>
            {lists.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {lists.slice(0, 6).map((l) => (
                  <li key={l.id}>
                    <Link
                      href={`/watchlists?id=${l.id}`}
                      className="flex justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted"
                    >
                      {l.name}
                      <span className="text-muted-foreground">
                        {l.count} {l.count === 1 ? "security" : "securities"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                None yet.{" "}
                <Link href="/watchlists" className="text-primary underline">
                  Create one
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="Recent alerts"
            action={
              <Link href="/alerts" className="text-sm text-primary hover:underline">
                Manage
              </Link>
            }
          />
          <CardContent>
            {events.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-col">
                    <span>{e.subject}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(e.date)} ·{" "}
                      {e.status === "sent"
                        ? "emailed"
                        : e.status === "suppressed"
                          ? "not emailed"
                          : e.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No alerts have fired yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top gainers" description={label} />
          <CardContent>
            {moves.gainers.length ? (
              <QuoteTable quotes={moves.gainers} session={session} />
            ) : (
              <p className="text-sm text-muted-foreground">No gainers this session.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Top losers" description={label} />
          <CardContent>
            {moves.losers.length ? (
              <QuoteTable quotes={moves.losers} session={session} />
            ) : (
              <p className="text-sm text-muted-foreground">No decliners this session.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
