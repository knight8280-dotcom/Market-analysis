import {
  Button,
  cn,
  formatCompact,
  formatDate,
  formatNumber,
  formatPercent,
  formatPrice,
  Input,
  MISSING,
  Table,
  Td,
  Th,
} from "@market/ui";
import Link from "next/link";
import { ordinal } from "../../lib/ordinal";
import type { MultipleHistory, PeerRow, ValuationView } from "../../server/valuation";

/** Peer multiples and the subject's own history (Phase 2 step D3). Descriptive only. */

const KEYS = [
  { key: "pe", label: "P/E", method: "Market cap ÷ net income, trailing twelve months" },
  { key: "ps", label: "P/S", method: "Market cap ÷ revenue, trailing twelve months" },
  {
    key: "evEbitda",
    label: "EV/EBITDA",
    method:
      "(Market cap + long-term debt − cash and short-term investments) ÷ (operating income + D&A), trailing twelve months",
  },
] as const;

const times = (v: number | null) => (v === null ? MISSING : `${formatNumber(v, 1)}×`);
const rank = (p: number | null) =>
  p === null ? MISSING : `${ordinal(Math.round(p * 100))} percentile`;

function PeerTableRow({ row, subject }: { row: PeerRow; subject?: boolean }) {
  return (
    <tr className={cn(subject && "bg-muted/50 font-medium")} data-testid={`peer-${row.ticker}`}>
      <Td>
        <Link
          href={`/stocks/${encodeURIComponent(row.ticker)}/valuation`}
          className="font-mono text-primary hover:underline"
        >
          {row.ticker}
        </Link>
        {subject ? <span className="sr-only"> (this company)</span> : null}
      </Td>
      <Td numeric className="tabular-nums">
        {row.price ? formatPrice(row.price.close) : MISSING}
        {row.price ? (
          <span className="block text-[11px] text-muted-foreground">
            {formatDate(row.price.date)}
          </span>
        ) : null}
      </Td>
      <Td numeric className="hidden tabular-nums sm:table-cell">
        {row.multiples.marketCap === null ? MISSING : `$${formatCompact(row.multiples.marketCap)}`}
      </Td>
      {KEYS.map((k) => (
        <Td key={k.key} numeric className="tabular-nums">
          {times(row.multiples[k.key])}
        </Td>
      ))}
    </tr>
  );
}

const W = 260;
const H = 90;

function HistoryChart({
  label,
  dates,
  values,
  median,
}: {
  label: string;
  dates: string[];
  values: (number | null)[];
  median: number | null;
}) {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length < 2) {
    return <p className="text-sm text-muted-foreground">{label}: not enough history.</p>;
  }
  const lo = Math.min(...xs, median ?? Infinity);
  const hi = Math.max(...xs, median ?? -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => 4 + (i / (dates.length - 1)) * (W - 8);
  const y = (v: number) => 6 + ((hi - v) / span) * (H - 12);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const current = values.at(-1) ?? null;
  return (
    <figure className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label} at month ends, ${formatDate(dates[0])} to ${formatDate(dates.at(-1))}: from ${times(lo)} to ${times(hi)}, median ${times(median)}, latest ${times(current)}.`}
      >
        {median !== null ? (
          <line
            x1={4}
            x2={W - 4}
            y1={y(median)}
            y2={y(median)}
            strokeDasharray="4 4"
            className="stroke-muted-foreground"
          />
        ) : null}
        <path d={d} fill="none" strokeWidth={1.8} className="stroke-primary" />
      </svg>
      <figcaption className="flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {label}: {times(lo)}–{times(hi)}
        </span>
        <span>median {times(median)} (dashed)</span>
      </figcaption>
    </figure>
  );
}

export function MultiplesSection({
  view,
  ticker,
  customPeers,
}: {
  view: ValuationView;
  ticker: string;
  customPeers: string[] | null;
}) {
  const basis =
    view.peerBasis.kind === "custom"
      ? "Your list"
      : view.peerBasis.kind === "none"
        ? null
        : `Same ${view.peerBasis.kind === "sic" ? "SEC industry code" : "industry"} (${view.peerBasis.label}), closest ${view.peers.length} by market cap`;
  const history: MultipleHistory | null = view.history;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Peer multiples" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Peers</h3>
            <p className="text-xs text-muted-foreground">
              {basis ??
                "No companies share this one's industry code in the stored data; list some below."}
            </p>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Peer tickers (comma-separated)
              <Input name="peers" defaultValue={customPeers?.join(", ") ?? ""} className="w-64" />
            </label>
            <Button type="submit" variant="secondary" size="sm">
              Compare
            </Button>
            {customPeers ? (
              <Link
                href={`/stocks/${encodeURIComponent(ticker)}/valuation`}
                className="min-h-8 px-2 text-sm underline"
              >
                Use the industry
              </Link>
            ) : null}
          </form>
        </div>
        <Table
          aria-label="Multiples of this company and its peers"
          scrollLabel="Peer multiples, scrollable"
        >
          <thead>
            <tr>
              <Th>Ticker</Th>
              <Th numeric>Price</Th>
              <Th numeric className="hidden sm:table-cell">
                Market cap
              </Th>
              {KEYS.map((k) => (
                <Th key={k.key} numeric title={k.method}>
                  {k.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            <PeerTableRow row={view.subject} subject />
            {view.peers.map((p) => (
              <PeerTableRow key={p.securityId} row={p} />
            ))}
            <tr className="font-medium">
              <Th scope="row" className="text-foreground">
                Peer median
              </Th>
              <Td />
              <Td className="hidden sm:table-cell" />
              {KEYS.map((k) => (
                <Td key={k.key} numeric className="tabular-nums" data-testid={`median-${k.key}`}>
                  {times(view.stats[k.key].median)}
                </Td>
              ))}
            </tr>
            <tr>
              <Th scope="row" className="text-foreground">
                {ticker} among peers
              </Th>
              <Td />
              <Td className="hidden sm:table-cell" />
              {KEYS.map((k) => (
                <Td key={k.key} numeric className="text-xs text-muted-foreground">
                  {rank(view.stats[k.key].percentile)}
                </Td>
              ))}
            </tr>
          </tbody>
        </Table>
        <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          {KEYS.map((k) => (
            <li key={k.key}>
              {k.label}: {k.method}. Unavailable when the denominator is not positive or a figure is
              missing.
            </li>
          ))}
          <li>
            Prices are end-of-day closes; figures are the latest filed (restatements included).
          </li>
        </ul>
      </section>

      <section aria-label="Multiples over five years" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{ticker} over five years</h3>
        {history ? (
          <>
            <p className="text-xs text-muted-foreground">
              Month-end closes against the figures known by each date, as first reported (no
              hindsight from restatements).
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              {KEYS.map((k) => (
                <div key={k.key} className="flex flex-col gap-1" data-testid={`history-${k.key}`}>
                  <HistoryChart
                    label={k.label}
                    dates={history.dates}
                    values={history[k.key]}
                    median={history.summary[k.key].median}
                  />
                  <p className="text-xs">
                    Latest {times(history[k.key].at(-1) ?? null)}:{" "}
                    {history.summary[k.key].percentile === null
                      ? "no earlier values to compare"
                      : `higher than ${formatPercent(history.summary[k.key].percentile, 0).replace("+", "")} of the earlier month-ends`}
                  </p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough price and filing history to chart this company&apos;s multiples.
          </p>
        )}
      </section>
    </div>
  );
}
