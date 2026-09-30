import { Button } from "@market/ui";
import { Check, Plus } from "lucide-react";
import Link from "next/link";
import { addToWatchlist, removeFromWatchlist } from "../app/(app)/watchlists/actions";
import { listWatchlists, watchlistsContaining } from "../server/watchlists";

/** "Watchlists" control on the ticker page: add to or remove from each list. */
export async function WatchlistMenu({
  securityId,
  ticker,
}: {
  securityId: string;
  ticker: string;
}) {
  const [lists, containing] = await Promise.all([
    listWatchlists(),
    watchlistsContaining(securityId),
  ]);
  const returnTo = `/stocks/${encodeURIComponent(ticker)}`;
  return (
    <details className="relative">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md border px-2.5 text-sm hover:bg-muted">
        Watchlists{containing.size ? ` (${containing.size})` : ""}
      </summary>
      <div className="absolute z-20 mt-1 w-64 rounded-lg border bg-surface p-2 shadow-xl">
        {lists.length === 0 ? (
          <p className="p-2 text-sm">
            <Link href="/watchlists" className="text-primary underline">
              Create a watchlist
            </Link>{" "}
            first.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {lists.map((l) => {
              const inList = containing.has(l.id);
              return (
                <li key={l.id}>
                  <form action={inList ? removeFromWatchlist : addToWatchlist}>
                    <input type="hidden" name="id" value={l.id} />
                    <input type="hidden" name="ticker" value={ticker} />
                    <input type="hidden" name="securityId" value={securityId} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      aria-label={`${inList ? "Remove from" : "Add to"} ${l.name}`}
                    >
                      {inList ? <Check aria-hidden /> : <Plus aria-hidden />}
                      {l.name}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
