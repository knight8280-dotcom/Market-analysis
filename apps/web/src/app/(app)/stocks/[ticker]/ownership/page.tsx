import { marketDateOf } from "@market/calendar";
import { COPY } from "@market/compliance";
import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  CODE_GROUPS,
  codeInfo,
  insiderFlows,
  ownersLabel,
  purchaseClusters,
  roleOf,
  TRANSACTION_CODES,
  type CodeGroup,
  type FlowSummary,
} from "@market/ownership";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  cn,
  Delta,
  EmptyState,
  formatDate,
  formatDateTimeET,
  formatNumber,
  formatPrice,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "../../../../../server/auth/owner";
import { db } from "../../../../../server/db";
import { filingUrl } from "../../../../../server/financials";
import { enabledFlags } from "../../../../../server/flags";
import { assertDisplayable, sourceInfo } from "../../../../../server/market";
import {
  holdingsView,
  insiderRows,
  shortInterestRows,
  type HoldingsView,
  type InsiderRow,
  type ShortInterestRow,
} from "../../../../../server/ownership";
import { securityForTicker, tickerOf } from "../../../../../server/stock";

type Params = Promise<{ ticker: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: `${tickerOf((await params).ticker)} ownership` };
}

const INSIDER_DAYS = 365;
const FLOW_DAYS = 90;

const daysBefore = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Share counts as filed: whole shares, or up to four decimals where a filing gives them. */
const qty = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
const signedQty = (n: number, sign: "A" | "D" | null) =>
  `${sign === "A" ? "+" : sign === "D" ? "−" : ""}${qty(n)}`;
const dollars = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

const muted = "text-xs text-muted-foreground";

/**
 * Ownership tab (Phase 2 step H4, spec §5.13): Form 4 insider transactions, 13F institutional
 * holders by quarter and FINRA short interest. Everything is shown as filed or published, with
 * the filing or settlement date it comes from; nothing here is a signal or a recommendation.
 */
export default async function OwnershipPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  const flags = await enabledFlags();
  if (!flags.ownership) notFound();
  const ticker = tickerOf((await params).ticker);
  const security = await securityForTicker(ticker);
  if (!security) notFound();
  const q = await searchParams;
  const quarter =
    typeof q.quarter === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.quarter) ? q.quarter : null;

  const appEnv = loadWebEnv().APP_ENV;
  assertDisplayable("sec_edgar", "filings", appEnv);
  assertDisplayable("sec_edgar", "institutional_holdings", appEnv);
  assertDisplayable("finra", "short_interest", appEnv);
  const database = db();
  const today = marketDateOf(new Date());
  const [insiders, holdings, shorts] = await Promise.all([
    security.cik
      ? insiderRows(database, security.cik, { since: daysBefore(today, INSIDER_DAYS) })
      : null,
    holdingsView(database, security.securityId, quarter),
    shortInterestRows(database, security.securityId),
  ]);
  const base = `/stocks/${encodeURIComponent(security.ticker)}/ownership`;

  return (
    <div className="flex flex-col gap-6">
      <Card aria-labelledby="insiders-title">
        <CardHeader
          title={<span id="insiders-title">Insider transactions (Form 4)</span>}
          description="Transactions in the last 12 months, newest first"
          action={
            flags.alert_types && security.cik ? (
              <Link
                href={`/alerts?ticker=${encodeURIComponent(security.ticker)}&kind=insider_purchase`}
                className="flex min-h-8 items-center rounded-md border px-2.5 text-sm whitespace-nowrap hover:bg-muted"
              >
                Alert on insider purchases
              </Link>
            ) : undefined
          }
        />
        <CardContent>
          {insiders === null ? (
            <EmptyState title="No SEC registrant">
              Insider transactions are reported to SEC EDGAR on Form 4, and this security has no SEC
              registrant (ETFs, funds and synthetic test securities do not).
            </EmptyState>
          ) : (
            <Insiders data={insiders} today={today} ticker={security.ticker} />
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="holders-title">
        <CardHeader
          title={<span id="holders-title">Institutional holders (13F)</span>}
          description="Positions reported by investment managers with $100 million or more in 13(f) securities"
        />
        <CardContent>
          <Holders view={holdings} base={base} />
        </CardContent>
      </Card>

      <Card aria-labelledby="short-title">
        <CardHeader
          title={<span id="short-title">Short interest</span>}
          description="Short positions reported to FINRA by its member firms, twice a month"
        />
        <CardContent>
          <ShortInterest rows={shorts} />
        </CardContent>
      </Card>
    </div>
  );
}

function flowLine(label: string, f: FlowSummary) {
  if (f.lines === 0) return `${label}: none.`;
  const priced =
    f.priced === f.lines
      ? `${dollars(f.value)} at the filed prices`
      : `${dollars(f.value)} at the filed prices on the ${f.priced} of ${f.lines} lines that give one`;
  return `${label}: ${qty(f.shares)} shares by ${f.insiders} insider${f.insiders === 1 ? "" : "s"} (${f.lines} line${f.lines === 1 ? "" : "s"}), ${priced}.`;
}

function Insiders({
  data,
  today,
  ticker,
}: {
  data: NonNullable<Awaited<ReturnType<typeof insiderRows>>>;
  today: string;
  ticker: string;
}) {
  const { rows, truncated, lastFiledAt, lastReadAt } = data;
  const label = (
    <DataLabel
      source={sourceInfo("sec_edgar")}
      kind="filing"
      asOf={lastFiledAt ? marketDateOf(lastFiledAt) : null}
      fetchedAt={lastReadAt}
    />
  );
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2">
        <EmptyState title="No insider transactions in the last 12 months">
          {lastReadAt
            ? `No Form 4 filed for ${ticker} reports a transaction since ${formatDate(daysBefore(today, INSIDER_DAYS))}.`
            : "No Form 4 filings have been read for this company yet. The worker reads them after the evening EDGAR refresh (pnpm worker insiders)."}
        </EmptyState>
        {lastReadAt ? label : null}
      </div>
    );
  }
  const flowsFrom = daysBefore(today, FLOW_DAYS);
  const flows = insiderFlows(rows, flowsFrom);
  const clusters = purchaseClusters(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="flows-title" className="flex flex-col gap-1 text-sm">
          <h3 id="flows-title" className="font-medium">
            Open-market trades since {formatDate(flowsFrom)}
          </h3>
          <p>{flowLine("Purchases (P)", flows.purchases)}</p>
          <p>{flowLine("Sales (S)", flows.sales)}</p>
          {flows.amendmentsLeftOut > 0 ? (
            <p className={muted}>
              {flows.amendmentsLeftOut} line{flows.amendmentsLeftOut === 1 ? "" : "s"} from
              amendments (4/A) left out of these totals: an amendment repeats the lines it corrects.
            </p>
          ) : null}
        </section>
        <section aria-labelledby="clusters-title" className="flex flex-col gap-1 text-sm">
          <h3 id="clusters-title" className="font-medium">
            Purchases by three or more insiders within 30 days
          </h3>
          {clusters.length === 0 ? (
            <p className="text-muted-foreground">None in the last 12 months.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {clusters.map((c) => (
                <li key={`${c.from}-${c.to}`}>
                  {formatDate(c.from)}
                  {c.to === c.from ? "" : ` to ${formatDate(c.to)}`}: {c.insiders.join(", ")} (
                  {c.filings.length} filing{c.filings.length === 1 ? "" : "s"})
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Table scrollLabel={`${ticker} insider transactions`}>
        <caption className="sr-only">
          {ticker} insider transactions from Form 4 filings, newest first
        </caption>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Insider</Th>
            <Th>Transaction</Th>
            <Th numeric>Shares</Th>
            <Th numeric>Price</Th>
            <Th numeric className="hidden md:table-cell">
              Held after
            </Th>
            <Th>Filing</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <InsiderTableRow key={`${r.accession_no}-${r.line}`} row={r} />
          ))}
        </tbody>
      </Table>
      {truncated ? (
        <p className={muted}>
          Showing the latest {rows.length} lines; the totals and clusters above cover only these.
        </p>
      ) : null}

      <details className="text-sm">
        <summary className="min-h-8 cursor-pointer py-1 font-medium">
          Transaction codes (SEC Form 4 instructions)
        </summary>
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          {(Object.keys(CODE_GROUPS) as CodeGroup[]).map((g) => (
            <div key={g}>
              <h4 className="text-xs font-medium text-muted-foreground">{CODE_GROUPS[g]}</h4>
              <dl className="mt-1 grid grid-cols-[2rem_1fr] gap-x-2 gap-y-1">
                {TRANSACTION_CODES.filter((c) => c.group === g).map((c) => (
                  <div key={c.code} className="contents">
                    <dt className="font-mono font-medium">{c.code}</dt>
                    <dd>{c.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </details>

      <div className="flex flex-col gap-1">
        <p className={muted}>
          {COPY.insiderNote} Signs follow the filing: + acquired, − disposed. &quot;10b5-1&quot;
          marks a filing whose reporting person checked the box for a Rule 10b5-1(c) trading plan.
        </p>
        {label}
      </div>
    </div>
  );
}

function InsiderTableRow({ row: r }: { row: InsiderRow }) {
  const code = codeInfo(r.code);
  const owner = r.owners[0];
  return (
    <tr>
      <Td className="whitespace-nowrap">{formatDate(r.transaction_date)}</Td>
      <Td>
        <span className="block">{ownersLabel(r.owners)}</span>
        {owner ? <span className={cn("block", muted)}>{roleOf(owner)}</span> : null}
      </Td>
      <Td>
        <span className="flex flex-wrap items-center gap-1">
          <Badge
            tone={r.code === "P" ? "up" : r.code === "S" ? "down" : "neutral"}
            title={code.description}
          >
            <span className="font-mono">{r.code}</span>
          </Badge>
          {code.label}
          {r.aff10b5One ? <Badge tone="info">10b5-1</Badge> : null}
        </span>
        {r.derivative ? (
          <span className={cn("block", muted)}>Derivative: {r.securityTitle}</span>
        ) : null}
        {r.notes.length ? (
          <details className="mt-1">
            <summary className={cn("cursor-pointer", muted)}>
              {r.notes.length === 1 ? "Note" : `${r.notes.length} notes`}
            </summary>
            <ul className={cn("mt-1 flex max-w-md flex-col gap-1", muted)}>
              {r.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Td>
      <Td numeric className="whitespace-nowrap">
        {r.shares === null ? "—" : signedQty(r.shares, r.acquired_disposed)}
      </Td>
      <Td numeric className="whitespace-nowrap">
        {r.price === null ? "—" : formatPrice(r.price)}
      </Td>
      <Td numeric className="hidden whitespace-nowrap md:table-cell">
        {qty(r.sharesAfter)}
        {r.ownership === "I" ? (
          <span className={cn("block", muted)}>
            Indirect{r.ownershipNature ? `: ${r.ownershipNature}` : ""}
          </span>
        ) : null}
      </Td>
      <Td className="whitespace-nowrap">
        <a
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          Form {r.form_type}
        </a>
        <span className={cn("block", muted)}>Filed {formatDateTimeET(r.filedAt)}</span>
      </Td>
    </tr>
  );
}

function Holders({ view, base }: { view: HoldingsView; base: string }) {
  if (!view.period) {
    return (
      <EmptyState title="No 13F positions loaded">
        {view.cusips === 0
          ? "No CUSIP is known for this security yet, so 13F positions cannot be matched to it. CUSIPs come from SEC's fails-to-deliver data, matched by ticker and issuer name."
          : `No 13F position in this security is in the data read so far${view.dataSetsThrough ? ` (SEC's 13F data sets through ${formatDate(view.dataSetsThrough)})` : ""}. The worker reads each new data set (pnpm worker 13f).`}
      </EmptyState>
    );
  }
  const { totals } = view;
  const shareChange =
    totals.previousShares && totals.previousShares > 0
      ? (totals.shares - totals.previousShares) / totals.previousShares
      : null;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Quarter" className="flex flex-wrap gap-1">
        {view.periods.map((p) => (
          <Link
            key={p}
            href={`${base}?quarter=${p}`}
            aria-current={p === view.period ? "true" : undefined}
            className={cn(
              "flex min-h-8 items-center rounded-md px-2.5 text-sm hover:bg-muted",
              p === view.period && "bg-muted font-medium",
            )}
          >
            {formatDate(p)}
          </Link>
        ))}
      </nav>

      {view.filed ? (
        <p className="text-sm">{COPY.thirteenF(view.period, view.filed.first, view.filed.last)}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt className={muted}>Filers with a position</dt>
          <dd className="font-medium">
            {formatNumber(totals.holders, 0)}
            {totals.previousHolders !== null ? (
              <span className={cn("block font-normal", muted)}>
                {formatNumber(totals.previousHolders, 0)} the quarter before
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className={muted}>Shares they report</dt>
          <dd className="font-medium">
            {qty(totals.shares)}
            {view.previous ? (
              <span className={cn("block font-normal", muted)}>
                <Delta fraction={shareChange} /> on {formatDate(view.previous)}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className={muted}>New positions</dt>
          <dd className="font-medium">
            {view.previous ? formatNumber(totals.newPositions, 0) : "—"}
          </dd>
        </div>
        <div>
          <dt className={muted}>No longer listed</dt>
          <dd className="font-medium">{view.previous ? formatNumber(totals.soldOut, 0) : "—"}</dd>
        </div>
      </dl>
      {view.previous ? null : (
        <p className={muted}>
          The quarter before is not loaded, so changes are not shown. 13F data is kept for eight
          quarters.
        </p>
      )}

      <Table scrollLabel={`Largest 13F positions on ${formatDate(view.period)}`}>
        <caption className="sr-only">
          Largest 13F positions as of quarter end {formatDate(view.period)}
        </caption>
        <thead>
          <tr>
            <Th>Filer</Th>
            <Th numeric>Shares</Th>
            <Th numeric>Change</Th>
            <Th numeric className="hidden md:table-cell">
              Value as reported
            </Th>
            <Th>Filing</Th>
          </tr>
        </thead>
        <tbody>
          {view.holders.map((h) => {
            const change =
              h.previousShares === null || h.previousShares === 0
                ? null
                : (h.shares - h.previousShares) / h.previousShares;
            return (
              <tr key={h.filerCik}>
                <Td>{h.filerName}</Td>
                <Td numeric className="whitespace-nowrap">
                  {qty(h.shares)}
                </Td>
                <Td numeric className="whitespace-nowrap">
                  {!view.previous ? (
                    "—"
                  ) : h.previousShares === null ? (
                    <Badge tone="info">New</Badge>
                  ) : (
                    <>
                      <span className="block">
                        {h.shares === h.previousShares
                          ? "No change"
                          : signedQty(
                              Math.abs(h.shares - h.previousShares),
                              h.shares > h.previousShares ? "A" : "D",
                            )}
                      </span>
                      {h.shares === h.previousShares ? null : <Delta fraction={change} />}
                    </>
                  )}
                </Td>
                <Td numeric className="hidden whitespace-nowrap md:table-cell">
                  {dollars(h.valueUsd)}
                </Td>
                <Td className="whitespace-nowrap">
                  {formatDate(h.filedOn)}
                  {h.accessions.map((a) => (
                    <a
                      key={a}
                      href={filingUrl(h.filerCik, a)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block font-mono text-xs text-primary underline underline-offset-2"
                    >
                      {a}
                    </a>
                  ))}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {totals.holders > view.holders.length ? (
        <p className={muted}>
          The {view.holders.length} largest of {formatNumber(totals.holders, 0)} positions.
        </p>
      ) : null}

      {view.soldOut.length > 0 ? (
        <section aria-labelledby="sold-title" className="flex flex-col gap-2">
          <h3 id="sold-title" className="text-sm font-medium">
            Listed on {formatDate(view.previous)}, not on {formatDate(view.period)}
          </h3>
          <Table scrollLabel="Positions no longer listed">
            <thead>
              <tr>
                <Th>Filer</Th>
                <Th numeric>Shares the quarter before</Th>
                <Th>This quarter&apos;s report filed</Th>
              </tr>
            </thead>
            <tbody>
              {view.soldOut.map((s) => (
                <tr key={s.filerCik}>
                  <Td>{s.filerName}</Td>
                  <Td numeric className="whitespace-nowrap">
                    {qty(s.previousShares)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(s.filedOn)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {totals.soldOut > view.soldOut.length ? (
            <p className={muted}>
              The {view.soldOut.length} largest of {formatNumber(totals.soldOut, 0)}.
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="flex flex-col gap-1">
        <p className={muted}>
          Long positions in the shares as the filer reports them (options and principal amounts are
          left out), matched to this security by CUSIP through SEC&apos;s fails-to-deliver data. An
          amended report that restates a filing replaces it; one that adds holdings adds to it.
          Values are in dollars as reported.
          {view.dataSetsThrough
            ? ` Read from SEC's 13F data sets through ${formatDate(view.dataSetsThrough)}; later filings are not in yet.`
            : ""}
        </p>
        <DataLabel source={sourceInfo("sec_edgar")} kind="filing" asOf={view.filed?.last ?? null} />
      </div>
    </div>
  );
}

function ShortInterest({ rows }: { rows: ShortInterestRow[] }) {
  const latest = rows[0];
  if (!latest) {
    return (
      <EmptyState title="No short interest loaded">
        Short interest comes from FINRA&apos;s Query API, which needs a free FINRA API credential
        (FINRA_API_CLIENT_ID and FINRA_API_CLIENT_SECRET in the worker&apos;s environment). With
        one, the worker reads it every evening at 19:30 ET.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table scrollLabel="Short interest by settlement date">
        <caption className="sr-only">Short interest by settlement date, newest first</caption>
        <thead>
          <tr>
            <Th>Settlement date</Th>
            <Th numeric>Short interest (shares)</Th>
            <Th numeric>Change</Th>
            <Th numeric className="hidden md:table-cell">
              Average daily volume
            </Th>
            <Th numeric>Days to cover</Th>
            <Th className="hidden md:table-cell">
              <span className="sr-only">Notes</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.settlementDate}>
              <Td className="whitespace-nowrap">{formatDate(r.settlementDate)}</Td>
              <Td numeric className="whitespace-nowrap">
                {qty(r.shortInterest)}
              </Td>
              <Td numeric>
                <Delta
                  fraction={
                    r.previousShortInterest
                      ? (r.shortInterest - r.previousShortInterest) / r.previousShortInterest
                      : null
                  }
                />
              </Td>
              <Td numeric className="hidden whitespace-nowrap md:table-cell">
                {qty(r.avgDailyVolume)}
              </Td>
              <Td numeric>{r.daysToCover === null ? "—" : formatNumber(r.daysToCover, 2)}</Td>
              <Td className="hidden md:table-cell">
                <span className="flex gap-1">
                  {r.revised ? <Badge tone="warning">Revised</Badge> : null}
                  {r.splitAdjusted ? <Badge>Split-adjusted</Badge> : null}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="flex flex-col gap-1">
        <p className={muted}>
          {COPY.shortInterest(latest.settlementDate)} Change is against FINRA&apos;s previous
          figure. Days to cover is short interest over average daily volume, as FINRA computes it;
          blank where FINRA reports no average volume. &quot;Revised&quot;: FINRA changed the figure
          after first publishing it.
        </p>
        <DataLabel
          source={sourceInfo("finra")}
          kind="settlement"
          asOf={latest.settlementDate}
          fetchedAt={latest.fetchedAt}
        />
      </div>
    </div>
  );
}
