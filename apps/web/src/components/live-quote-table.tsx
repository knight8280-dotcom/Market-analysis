"use client";

import { DataLabel, type SourceInfo } from "@market/compliance/client";
import { Button, cn, Delta, formatDate, formatPrice } from "@market/ui";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { moveInWatchlist, removeFromWatchlist } from "../app/(app)/watchlists/actions";

export interface LiveRow {
  securityId: string;
  ticker: string;
  name: string;
  quote: { date: string; close: number; change: number | null } | null;
}

type Status = "connecting" | "live" | "reconnecting" | "off";

/**
 * A watchlist's quotes, updated in place when the worker loads new bars (server-sent events
 * from /api/stream, at most one update per second per security). Without Redis the table simply
 * shows the page's data.
 */
export function LiveQuoteTable({
  watchlistId,
  rows,
  source,
  session,
  fetchedAt,
}: {
  watchlistId: string;
  rows: LiveRow[];
  source: SourceInfo | null;
  session: string | null;
  fetchedAt: string | null;
}) {
  const [quotes, setQuotes] = useState(() => new Map(rows.map((r) => [r.securityId, r.quote])));
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>("connecting");
  const [announcement, setAnnouncement] = useState("");
  const ids = rows.map((r) => r.securityId).join(",");

  useEffect(() => {
    setQuotes(new Map(rows.map((r) => [r.securityId, r.quote])));
  }, [rows]);

  useEffect(() => {
    if (!ids) {
      setStatus("off");
      return;
    }
    const es = new EventSource(`/api/stream?ids=${ids}`);
    es.addEventListener("ready", () => setStatus("live"));
    es.addEventListener("unavailable", () => {
      setStatus("off");
      es.close();
    });
    es.addEventListener("quote", (e) => {
      const q = JSON.parse((e as MessageEvent<string>).data) as {
        securityId: string;
        ticker: string;
        date: string;
        close: number;
        change: number | null;
      };
      setQuotes((m) =>
        new Map(m).set(q.securityId, { date: q.date, close: q.close, change: q.change }),
      );
      setFlash((s) => new Set(s).add(q.securityId));
      setTimeout(
        () =>
          setFlash((s) => {
            const n = new Set(s);
            n.delete(q.securityId);
            return n;
          }),
        1500,
      );
      setAnnouncement(`${q.ticker} updated: ${formatPrice(q.close)}`);
    });
    es.onerror = () => setStatus((s) => (s === "off" ? s : "reconnecting"));
    return () => es.close();
  }, [ids]);

  const statusText: Record<Status, string> = {
    connecting: "Connecting for live updates…",
    live: "Live: updates as new bars load",
    reconnecting: "Live updates reconnecting…",
    off: "Live updates off (the worker's Redis is not configured)",
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn("size-2 rounded-full", status === "live" ? "bg-up" : "bg-muted-foreground")}
        />
        <span data-testid="live-status">{statusText[status]}</span>
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div tabIndex={0} role="region" aria-label="Watchlist quotes" className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Ticker", "Name", "Price", "Change", "Order", ""].map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className={cn(
                    "border-b px-3 py-2 text-xs font-medium text-muted-foreground",
                    i >= 2 && i <= 3 ? "text-right" : "text-left",
                    i === 1 && "hidden md:table-cell",
                  )}
                >
                  {h ? h : <span className="sr-only">Remove</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const q = quotes.get(r.securityId) ?? null;
              return (
                <tr
                  key={r.securityId}
                  data-testid={`row-${r.ticker}`}
                  data-security-id={r.securityId}
                  className={cn("transition-colors", flash.has(r.securityId) && "bg-primary/15")}
                >
                  <td className="border-b border-border/60 px-3 py-1.5">
                    <Link
                      href={`/stocks/${encodeURIComponent(r.ticker)}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {r.ticker}
                    </Link>
                  </td>
                  <td className="hidden max-w-72 truncate border-b border-border/60 px-3 py-1.5 text-muted-foreground md:table-cell">
                    {r.name}
                  </td>
                  <td className="border-b border-border/60 px-3 py-1.5 text-right whitespace-nowrap">
                    {q ? formatPrice(q.close) : <span className="text-muted-foreground">—</span>}
                    {q && session && q.date !== session ? (
                      <span className="block text-xs text-warning">as of {formatDate(q.date)}</span>
                    ) : null}
                  </td>
                  <td className="border-b border-border/60 px-3 py-1.5 text-right">
                    <Delta fraction={q?.change ?? null} />
                  </td>
                  <td className="border-b border-border/60 px-3 py-1">
                    <span className="flex gap-1">
                      {(["up", "down"] as const).map((dir) => (
                        <form key={dir} action={moveInWatchlist}>
                          <input type="hidden" name="id" value={watchlistId} />
                          <input type="hidden" name="securityId" value={r.securityId} />
                          <input type="hidden" name="dir" value={dir} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="icon"
                            disabled={dir === "up" ? i === 0 : i === rows.length - 1}
                            aria-label={`Move ${r.ticker} ${dir}`}
                          >
                            {dir === "up" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                          </Button>
                        </form>
                      ))}
                    </span>
                  </td>
                  <td className="border-b border-border/60 px-3 py-1 text-right">
                    <form action={removeFromWatchlist}>
                      <input type="hidden" name="id" value={watchlistId} />
                      <input type="hidden" name="securityId" value={r.securityId} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${r.ticker}`}
                      >
                        <X aria-hidden />
                      </Button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {source && session ? (
        <DataLabel source={source} kind="eod" asOf={session} fetchedAt={fetchedAt} />
      ) : null}
    </div>
  );
}
