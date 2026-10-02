import { loadWebEnv } from "@market/config";
import { Button, Card, CardContent, CardHeader, cn, EmptyState, Input } from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveQuoteTable, type LiveRow } from "../../../components/live-quote-table";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import {
  assertDisplayable,
  lastUpdated,
  latestQuotes,
  priceSource,
  sourceInfo,
} from "../../../server/market";
import { listWatchlists, watchlistEntries } from "../../../server/watchlists";
import { addToWatchlist, createWatchlist, deleteWatchlist, renameWatchlist } from "./actions";

export const metadata: Metadata = { title: "Watchlists" };

const ERRORS: Record<string, string> = {
  ticker: "No security with that ticker is loaded.",
  name: "Give the watchlist a name.",
  duplicate: "You already have a watchlist with that name.",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

function CreateForm({ first }: { first?: boolean }) {
  return (
    <form action={createWatchlist} className="flex gap-2">
      <Input
        name="name"
        placeholder={first ? "e.g. Core holdings" : "New watchlist"}
        aria-label="Watchlist name"
        required
        maxLength={100}
      />
      <Button type="submit" variant={first ? "primary" : "secondary"}>
        Create
      </Button>
    </form>
  );
}

/** Watchlists (Phase 1 step G): owner-only lists with live-updating quotes. */
export default async function WatchlistsPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const error = ERRORS[one("error") ?? ""];
  const lists = await listWatchlists();

  if (lists.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Watchlists</h1>
        <EmptyState title="Create your first watchlist" action={<CreateForm first />}>
          Group the securities you follow; their quotes update here as new bars load.
        </EmptyState>
        {error ? (
          <p role="alert" className="text-center text-sm text-down">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const selected = lists.find((l) => l.id === one("id")) ?? lists[0]!;
  const entries = await watchlistEntries(selected.id);
  const database = db();
  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const [quotes, updated] = source
    ? await Promise.all([
        entries.length
          ? latestQuotes(database, source, { securityIds: entries.map((e) => e.securityId) })
          : Promise.resolve([]),
        lastUpdated(database, source),
      ])
    : [[], null];
  const quoteOf = new Map(quotes.map((x) => [x.securityId, x]));
  const rows: LiveRow[] = entries.map((e) => {
    const x = quoteOf.get(e.securityId);
    return {
      securityId: e.securityId,
      ticker: e.ticker,
      name: e.name,
      quote: x ? { date: x.date, close: x.close, change: x.change } : null,
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Watchlists</h1>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <nav aria-label="Watchlists">
            <ul className="flex flex-col gap-1 text-sm">
              {lists.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`/watchlists?id=${l.id}`}
                    aria-current={l.id === selected.id ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted",
                      l.id === selected.id && "bg-muted font-medium",
                    )}
                  >
                    <span className="min-w-0 break-words">{l.name}</span>
                    <span className="text-xs text-muted-foreground">{l.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <CreateForm />
        </aside>

        <Card>
          <CardHeader
            title={selected.name}
            description={`${entries.length} ${entries.length === 1 ? "security" : "securities"}`}
            action={
              <div className="flex items-center gap-1">
                <details className="relative">
                  <summary className="flex min-h-8 cursor-pointer list-none items-center rounded-md px-2.5 text-sm hover:bg-muted">
                    Rename
                  </summary>
                  <form
                    action={renameWatchlist}
                    className="absolute right-0 z-20 mt-1 flex w-72 gap-2 rounded-lg border bg-surface p-3 shadow-xl"
                  >
                    <input type="hidden" name="id" value={selected.id} />
                    <Input
                      name="name"
                      defaultValue={selected.name}
                      aria-label="New name"
                      required
                    />
                    <Button type="submit">Save</Button>
                  </form>
                </details>
                <form action={deleteWatchlist}>
                  <input type="hidden" name="id" value={selected.id} />
                  <Button type="submit" variant="destructive" size="sm">
                    Delete
                  </Button>
                </form>
              </div>
            }
          />
          <CardContent className="flex flex-col gap-4">
            <form action={addToWatchlist} className="flex max-w-sm gap-2">
              <input type="hidden" name="id" value={selected.id} />
              <Input
                name="ticker"
                placeholder="Ticker, e.g. AAPL"
                aria-label="Ticker to add"
                required
                maxLength={15}
                autoCapitalize="characters"
              />
              <Button type="submit">Add</Button>
            </form>
            {error ? (
              <p role="alert" className="text-sm text-down">
                {error}
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Empty. Add a ticker above, or use &quot;Watchlists&quot; on any ticker page.
              </p>
            ) : (
              <LiveQuoteTable
                watchlistId={selected.id}
                rows={rows}
                source={source ? sourceInfo(source) : null}
                session={updated?.session ?? null}
                fetchedAt={updated?.loadedAt?.toISOString() ?? null}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
