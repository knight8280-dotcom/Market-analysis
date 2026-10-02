import "server-only";
import { marketDateOf } from "@market/calendar";
import { DataLabel } from "@market/compliance/client";
import type { Database } from "@market/db";
import type { ProviderId } from "@market/market-data";
import { runScreen } from "@market/screener";
import {
  Card,
  CardContent,
  CardHeader,
  Delta,
  formatDate,
  formatPercent,
  formatPrice,
  Table,
  Td,
  Th,
} from "@market/ui";
import Link from "next/link";
import { cache, type ReactNode } from "react";
import { WIDGETS, type WidgetId } from "../../lib/dashboard";
import { recentAlertEvents } from "../../server/alerts";
import { earningsBetween, releasesBetween } from "../../server/calendars";
import { latestQuotes, movers, sourceInfo, type Quote } from "../../server/market";
import { listPortfolios, portfolioTransactions, portfolioView } from "../../server/portfolio";
import { savedScreens } from "../../server/screens";
import { listWatchlists } from "../../server/watchlists";

/** What every widget needs: the price source and the session it shows. */
export interface WidgetContext {
  database: Database;
  source: ProviderId;
  session: string;
  loadedAt: Date | null;
  /** The saved screen the screen widget shows. */
  screenId?: string;
}

const INDEX_ETFS = ["SPY", "QQQ", "DIA", "IWM"];
const moversOf = cache((database: Database, source: ProviderId, session: string) =>
  movers(database, source, session),
);

const eodLabel = (c: WidgetContext) => (
  <DataLabel source={sourceInfo(c.source)} kind="eod" asOf={c.session} fetchedAt={c.loadedAt} />
);
const openLink = (href: string, text: string) => (
  <Link href={href} className="text-sm text-primary hover:underline">
    {text}
  </Link>
);

/** Name only on the widest screens: two tables can sit side by side next to the sidebar. */
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

function Widget({
  id,
  description,
  action,
  children,
}: {
  id: WidgetId;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader title={WIDGETS[id].title} description={description} action={action} />
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const quiet = (text: ReactNode) => <p className="text-sm text-muted-foreground">{text}</p>;

async function Indices({ c }: { c: WidgetContext }) {
  const quotes = await latestQuotes(c.database, c.source, { tickers: INDEX_ETFS });
  quotes.sort((a, b) => INDEX_ETFS.indexOf(a.ticker) - INDEX_ETFS.indexOf(b.ticker));
  return (
    <Widget id="indices" description={eodLabel(c)}>
      {quotes.length ? (
        <QuoteTable quotes={quotes} session={c.session} />
      ) : (
        quiet("None of SPY, QQQ, DIA or IWM is loaded.")
      )}
    </Widget>
  );
}

async function Movers({ c, kind }: { c: WidgetContext; kind: "gainers" | "losers" }) {
  const moves = await moversOf(c.database, c.source, c.session);
  const quotes = moves[kind];
  return (
    <Widget id={kind} description={eodLabel(c)}>
      {quotes.length ? (
        <QuoteTable quotes={quotes} session={c.session} />
      ) : (
        quiet(kind === "gainers" ? "No gainers this session." : "No decliners this session.")
      )}
    </Widget>
  );
}

async function Watchlists() {
  const lists = await listWatchlists();
  return (
    <Widget id="watchlists" action={openLink("/watchlists", "Open")}>
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
        quiet(
          <>
            None yet.{" "}
            <Link href="/watchlists" className="text-primary underline">
              Create one
            </Link>
            .
          </>,
        )
      )}
    </Widget>
  );
}

async function Alerts() {
  const events = await recentAlertEvents({ limit: 5 });
  return (
    <Widget id="alerts" action={openLink("/alerts", "Manage")}>
      {events.length ? (
        <ul className="flex flex-col gap-2 text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex flex-col">
              <Link href={`/alerts/${e.alertId}`} className="hover:underline">
                {e.subject}
              </Link>
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
        quiet("No alerts have fired yet.")
      )}
    </Widget>
  );
}

async function Portfolios({ c }: { c: WidgetContext }) {
  const portfolios = (await listPortfolios()).slice(0, 3);
  const rows = await Promise.all(
    portfolios.map(async (p) => {
      const txs = await portfolioTransactions(p.id);
      if (txs.length === 0) return { p, view: null };
      return { p, view: await portfolioView(c.database, c.source, c.session, txs, p.benchmark) };
    }),
  );
  return (
    <Widget id="portfolio" description={eodLabel(c)} action={openLink("/portfolio", "Open")}>
      {rows.length === 0 ? (
        quiet(
          <>
            No portfolios yet.{" "}
            <Link href="/portfolio" className="text-primary underline">
              Start one
            </Link>
            .
          </>,
        )
      ) : (
        <Table aria-label="Portfolio summary">
          <thead>
            <tr>
              <Th>Portfolio</Th>
              <Th numeric>Value</Th>
              <Th numeric>Day</Th>
              <Th numeric title="Time-weighted return since the first transaction">
                Return
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, view }) => {
              const day = view?.risk.dailyPnl.at(-1) ?? null;
              return (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/portfolio?id=${p.id}`} className="text-primary hover:underline">
                      {p.name}
                    </Link>
                  </Td>
                  <Td numeric>{view ? formatPrice(view.report.value) : "—"}</Td>
                  <Td numeric>{day && day.date === c.session ? formatPrice(day.pnl) : "—"}</Td>
                  <Td numeric>
                    {view?.report.twr !== null && view?.report.twr !== undefined ? (
                      <Delta fraction={view.report.twr} />
                    ) : (
                      "—"
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Widget>
  );
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const HOUR: Record<string, string> = { bmo: "before open", amc: "after close" };

async function ComingUp({ c }: { c: WidgetContext }) {
  const today = marketDateOf(new Date());
  const to = addDays(today, 14);
  const [earnings, releases] = await Promise.all([
    earningsBetween(c.database, today, to),
    releasesBetween(c.database, today, to),
  ]);
  const yours = earnings
    .filter((e) => e.onWatchlist)
    .concat(earnings.filter((e) => !e.onWatchlist))
    .slice(0, 6);
  const major = releases.filter((r) => r.major).slice(0, 4);
  return (
    <Widget
      id="calendar"
      description="The next 14 days; watchlist companies first"
      action={openLink("/calendar", "Open calendar")}
    >
      <div className="flex flex-col gap-3 text-sm">
        {yours.length === 0 && major.length === 0
          ? quiet("Nothing scheduled in the next 14 days.")
          : null}
        {yours.length ? (
          <ul aria-label="Upcoming earnings" className="flex flex-col gap-1">
            {yours.map((e) => (
              <li key={`${e.ticker}-${e.date}`} className="flex justify-between gap-2">
                <Link
                  href={`/stocks/${encodeURIComponent(e.ticker)}`}
                  className="font-mono text-primary hover:underline"
                >
                  {e.ticker}
                </Link>
                <span className="text-muted-foreground">
                  Earnings {formatDate(e.date)}
                  {e.hour && HOUR[e.hour] ? `, ${HOUR[e.hour]}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {major.length ? (
          <ul aria-label="Upcoming economic releases" className="flex flex-col gap-1">
            {major.map((r) => (
              <li key={`${r.releaseId}-${r.date}`} className="flex justify-between gap-2">
                <span>{r.name}</span>
                <span className="text-muted-foreground">{formatDate(r.date)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <span className="flex flex-col gap-0.5 text-xs">
          <DataLabel source={sourceInfo("finnhub")} kind="observation" asOf={null} />
          <DataLabel source={sourceInfo("fred")} kind="observation" asOf={null} />
        </span>
      </div>
    </Widget>
  );
}

async function ScreenResults({ c }: { c: WidgetContext }) {
  const screens = await savedScreens();
  const chosen = screens.find((s) => s.id === c.screenId) ?? screens[0];
  if (!chosen) {
    return (
      <Widget id="screen">
        {quiet(
          <>
            No saved screens yet. Save one on the{" "}
            <Link href="/screener" className="text-primary underline">
              Screener
            </Link>{" "}
            to see its top results here.
          </>,
        )}
      </Widget>
    );
  }
  const { rows, total } = await runScreen(c.database, chosen.screen, { limit: 8, offset: 0 });
  const asOf = rows.reduce<string | null>((d, r) => {
    const v = r.as_of === null ? null : String(r.as_of);
    return v && (!d || v > d) ? v : d;
  }, null);
  return (
    <Widget
      id="screen"
      description={
        <span className="flex flex-col gap-0.5">
          <span>
            “{chosen.name}”: {total} {total === 1 ? "result" : "results"}, the first{" "}
            {Math.min(total, 8)} by its sort
          </span>
          <DataLabel source={sourceInfo(c.source)} kind="eod" asOf={asOf} />
        </span>
      }
      action={openLink(`/screener?saved=${encodeURIComponent(chosen.id)}`, "Open screen")}
    >
      {rows.length === 0 ? (
        quiet("Nothing matches this screen today.")
      ) : (
        <Table aria-label={`Results of ${chosen.name}`}>
          <thead>
            <tr>
              <Th>Ticker</Th>
              <Th className="hidden sm:table-cell">Name</Th>
              <Th numeric>Close</Th>
              <Th numeric>1 day</Th>
              <Th numeric className="hidden md:table-cell">
                1 year
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.security_id)}>
                <Td>
                  <Link
                    href={`/stocks/${encodeURIComponent(String(r.ticker))}`}
                    className="font-mono font-medium text-primary hover:underline"
                  >
                    {String(r.ticker)}
                  </Link>
                </Td>
                <Td className="hidden max-w-56 truncate text-muted-foreground sm:table-cell">
                  {String(r.name)}
                </Td>
                <Td numeric>{r.close === null ? "—" : formatPrice(Number(r.close))}</Td>
                <Td numeric>
                  {r.change_1d === null ? "—" : <Delta fraction={Number(r.change_1d)} />}
                </Td>
                <Td numeric className="hidden md:table-cell">
                  {r.return_1y === null ? "—" : formatPercent(Number(r.return_1y))}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Widget>
  );
}

/** The widget for an id, as a server component. */
export function DashboardWidget({ id, c }: { id: WidgetId; c: WidgetContext }) {
  switch (id) {
    case "indices":
      return <Indices c={c} />;
    case "watchlists":
      return <Watchlists />;
    case "alerts":
      return <Alerts />;
    case "gainers":
    case "losers":
      return <Movers c={c} kind={id} />;
    case "portfolio":
      return <Portfolios c={c} />;
    case "calendar":
      return <ComingUp c={c} />;
    case "screen":
      return <ScreenResults c={c} />;
  }
}
