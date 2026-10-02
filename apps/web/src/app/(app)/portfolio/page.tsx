import { marketDateOf } from "@market/calendar";
import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import { CSV_TEMPLATE } from "@market/portfolio";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
  Delta,
  EmptyState,
  formatDate,
  formatPercent,
  formatPrice,
  Input,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { ImportForm } from "../../../components/portfolio/import-form";
import { PerformanceChart } from "../../../components/performance-chart";
import { RiskPanel } from "../../../components/portfolio/risk-panel";
import { TransactionForm } from "../../../components/portfolio/tx-form";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { flagEnabled } from "../../../server/flags";
import { assertDisplayable, lastUpdated, priceSource, sourceInfo } from "../../../server/market";
import { listPortfolios, portfolioTransactions, portfolioView } from "../../../server/portfolio";
import { createPortfolio, deletePortfolio, deleteTransaction } from "./actions";

export const metadata: Metadata = { title: "Portfolio" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const qty = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(n);
const ASSET_LABEL: Record<string, string> = {
  equity: "Stocks",
  adr: "Stocks (ADRs)",
  etf: "ETFs",
  fund: "Funds",
  preferred: "Preferred shares",
};

/** Shares of the portfolio's value, as labelled bars (the percentage is always written). */
function AllocationList({
  label,
  items,
  total,
}: {
  label: string;
  items: [string, number][];
  total: number;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2 text-sm">
      {items.map(([name, value]) => {
        const w = total > 0 ? value / total : 0;
        return (
          <li key={name} className="flex flex-col gap-1">
            <span className="flex justify-between gap-2">
              <span>{name}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatPercent(w, 1).replace("+", "")}
              </span>
            </span>
            <span aria-hidden className="h-1.5 rounded bg-muted">
              <span
                className="block h-1.5 rounded bg-primary"
                style={{ width: `${Math.max(0, Math.min(1, w)) * 100}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const TYPE_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  fee: "Fee",
};

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border bg-surface p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function CreateForm({ first }: { first?: boolean }) {
  return (
    <form action={createPortfolio} className="flex flex-wrap gap-2">
      <Input
        name="name"
        placeholder={first ? "e.g. Brokerage" : "New portfolio"}
        aria-label="Portfolio name"
        required
        maxLength={100}
        className="w-48"
      />
      <Input
        name="benchmark"
        defaultValue="SPY"
        aria-label="Benchmark ticker"
        maxLength={15}
        className="w-24"
      />
      <Button type="submit" variant={first ? "primary" : "secondary"}>
        Create
      </Button>
    </form>
  );
}

/** Portfolio tracker (Phase 1 step J): the owner's own entries, valued at end-of-day closes. */
export default async function PortfolioPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const portfolios = await listPortfolios();

  if (portfolios.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Portfolio</h1>
        <EmptyState title="Track a portfolio" action={<CreateForm first />}>
          Enter or import your transactions; returns, allocation and dividends are calculated from
          them and end-of-day closes. Nothing leaves this app.
        </EmptyState>
        {one("error") === "name" ? (
          <p role="alert" className="text-center text-sm text-down">
            Give the portfolio a name.
          </p>
        ) : null}
      </div>
    );
  }

  const selected = portfolios.find((p) => p.id === one("id")) ?? portfolios[0]!;
  const database = db();
  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const updated = source ? await lastUpdated(database, source) : null;
  const session = updated?.session ?? marketDateOf(new Date());
  const txs = await portfolioTransactions(selected.id);
  const view = source
    ? await portfolioView(database, source, session, txs, selected.benchmark)
    : null;
  const report = view?.report;
  const riskOn = await flagEnabled("portfolio_risk");
  const info = (id: string) => view?.securities.get(id);
  const sectors = new Map<string, number>();
  for (const p of report?.positions ?? []) {
    const s = info(p.securityId)?.sector ?? "Unclassified";
    sectors.set(s, (sectors.get(s) ?? 0) + p.marketValue);
  }
  if (report && report.cash > 0.005) sectors.set("Cash", report.cash);
  const allocation = [...sectors].sort((a, b) => b[1] - a[1]);
  const classes = new Map<string, number>();
  for (const p of report?.positions ?? []) {
    const c = info(p.securityId)?.assetClass ?? "unknown";
    const name = ASSET_LABEL[c] ?? c[0]!.toUpperCase() + c.slice(1);
    classes.set(name, (classes.get(name) ?? 0) + p.marketValue);
  }
  if (report && report.cash > 0.005) classes.set("Cash", report.cash);
  const byClass = [...classes].sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Portfolio</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Calculated from your entries and end-of-day closes. Figures are informational, not
            investment or tax advice.
          </p>
        </div>
        <CreateForm />
      </div>

      <nav aria-label="Portfolios" className="flex flex-wrap gap-1 border-b">
        {portfolios.map((p) => (
          <Link
            key={p.id}
            href={`/portfolio?id=${p.id}`}
            aria-current={p.id === selected.id ? "page" : undefined}
            className={cn(
              "-mb-px flex min-h-9 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground",
              p.id === selected.id && "border-primary font-medium text-foreground",
            )}
          >
            {p.name}
            <span className="text-xs text-muted-foreground">{p.count}</span>
          </Link>
        ))}
      </nav>

      {report && report.days.length > 0 ? (
        <>
          <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Value"
              testId="stat-value"
              value={formatPrice(report.value)}
              detail={`as of ${formatDate(report.end)}; cash ${formatPrice(report.cash)}`}
            />
            <Stat
              label="Time-weighted return"
              testId="stat-twr"
              value={<Delta fraction={report.twr} />}
              detail={`since ${formatDate(report.start)}${
                report.twrAnnualized !== null
                  ? `; ${formatPercent(report.twrAnnualized)} a year`
                  : ""
              }`}
            />
            <Stat
              label="Money-weighted return (XIRR)"
              testId="stat-xirr"
              value={report.xirr === null ? "—" : formatPercent(report.xirr)}
              detail="a year, counting when you added or withdrew money"
            />
            <Stat
              label={view.benchmark ? `${view.benchmark.ticker}, same period` : "Benchmark"}
              testId="stat-benchmark"
              value={
                view.benchmark && view.benchmark.total !== null ? (
                  <Delta fraction={view.benchmark.total} />
                ) : (
                  "—"
                )
              }
              detail={
                view.benchmark
                  ? "total return, dividends reinvested"
                  : `${selected.benchmark} has no prices loaded`
              }
            />
            <Stat
              label="Unrealized gain"
              value={formatPrice(report.unrealized)}
              detail={`realized ${formatPrice(report.realized)}`}
            />
            <Stat
              label="Dividends received"
              testId="stat-dividends"
              value={formatPrice(report.dividends)}
            />
            <Stat
              label="Largest drawdown"
              value={report.maxDrawdown === null ? "—" : formatPercent(-report.maxDrawdown)}
              detail="peak to trough, time-weighted"
            />
            <Stat
              label="Net money in"
              value={formatPrice(report.netContributions)}
              detail={`fees ${formatPrice(report.fees)}`}
            />
          </section>

          <Card>
            <CardHeader
              title="Performance"
              description={
                source ? (
                  <DataLabel
                    source={sourceInfo(source)}
                    kind="eod"
                    asOf={session}
                    fetchedAt={updated?.loadedAt ?? null}
                  />
                ) : null
              }
            />
            <CardContent>
              <PerformanceChart
                dates={report.days.map((d) => d.date)}
                portfolio={report.days.map((d) => d.index)}
                benchmark={view.benchmark?.index ?? null}
                benchmarkLabel={view.benchmark?.ticker ?? null}
              />
            </CardContent>
          </Card>

          {riskOn ? (
            <RiskPanel
              risk={view.risk}
              benchmark={view.benchmark?.ticker ?? null}
              riskFreeStored={view.riskFree}
              tickers={(id) => info(id)?.ticker ?? id}
            />
          ) : null}

          {report.warnings.length ? (
            <div
              role="note"
              className="rounded-md border border-warning/50 p-3 text-sm text-warning"
            >
              <p className="font-medium">Check these entries</p>
              <ul className="mt-1 list-disc pl-5">
                {report.warnings.slice(0, 10).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <Card>
              <CardHeader
                title="Holdings"
                description={
                  <span className="flex flex-col gap-0.5">
                    <span>
                      {report.positions.length}{" "}
                      {report.positions.length === 1 ? "position" : "positions"}
                    </span>
                    {source ? (
                      <DataLabel
                        source={sourceInfo(source)}
                        kind="eod"
                        asOf={session}
                        fetchedAt={updated?.loadedAt ?? null}
                      />
                    ) : null}
                  </span>
                }
              />
              <CardContent>
                {report.positions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open positions.</p>
                ) : (
                  <div tabIndex={0} role="region" aria-label="Holdings" className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>
                          <Th>Ticker</Th>
                          <Th numeric>Quantity</Th>
                          <Th numeric className="hidden md:table-cell">
                            Avg cost
                          </Th>
                          <Th numeric>Price</Th>
                          <Th numeric>Value</Th>
                          <Th numeric>Gain</Th>
                          <Th numeric>Weight</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.positions.map((p) => {
                          const s = info(p.securityId);
                          return (
                            <tr
                              key={p.securityId}
                              data-testid={`holding-${s?.ticker ?? p.securityId}`}
                            >
                              <Td>
                                <Link
                                  href={`/stocks/${encodeURIComponent(s?.ticker ?? "")}`}
                                  className="font-mono font-medium text-primary hover:underline"
                                >
                                  {s?.ticker ?? p.securityId}
                                </Link>
                              </Td>
                              <Td numeric>{qty(p.quantity)}</Td>
                              <Td numeric className="hidden md:table-cell">
                                {formatPrice(p.costBasis / p.quantity)}
                              </Td>
                              <Td numeric>
                                {p.price === null ? "—" : formatPrice(p.price)}
                                {p.priceDate && p.priceDate !== session ? (
                                  <span className="block text-xs text-warning">
                                    as of {formatDate(p.priceDate)}
                                  </span>
                                ) : null}
                              </Td>
                              <Td numeric>{formatPrice(p.marketValue)}</Td>
                              <Td numeric>
                                <span className="flex flex-col items-end">
                                  {formatPrice(p.unrealized)}
                                  <Delta
                                    fraction={p.costBasis > 0 ? p.unrealized / p.costBasis : null}
                                    className="text-xs"
                                  />
                                </span>
                              </Td>
                              <Td numeric>{formatPercent(p.weight, 1).replace("+", "")}</Td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader
                title="Allocation"
                description="Shares of the portfolio's value, with cash"
              />
              <CardContent className="flex flex-col gap-5">
                {riskOn ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">By asset class</h3>
                    <AllocationList
                      label="Allocation by asset class"
                      items={byClass}
                      total={report.value}
                    />
                  </section>
                ) : null}
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    By sector (SIC-based)
                  </h3>
                  <AllocationList
                    label="Allocation by sector"
                    items={allocation}
                    total={report.value}
                  />
                </section>
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {source
            ? "No transactions yet. Add one below or import a CSV."
            : "No prices are loaded yet, so holdings cannot be valued."}
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Add a transaction" />
          <CardContent>
            <TransactionForm portfolioId={selected.id} today={marketDateOf(new Date())} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="Import CSV"
            description="All rows or none; problems are listed by line"
          />
          <CardContent>
            <ImportForm portfolioId={selected.id} template={CSV_TEMPLATE} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Transactions"
          description={`${txs.length} ${txs.length === 1 ? "entry" : "entries"}`}
          action={
            <form action={deletePortfolio}>
              <input type="hidden" name="id" value={selected.id} />
              <Button type="submit" variant="destructive" size="sm">
                Delete portfolio
              </Button>
            </form>
          }
        />
        <CardContent>
          {txs.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <div tabIndex={0} role="region" aria-label="Transactions" className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th>Ticker</Th>
                    <Th numeric>Quantity</Th>
                    <Th numeric>Price</Th>
                    <Th numeric>Amount</Th>
                    <Th numeric className="hidden md:table-cell">
                      Fees
                    </Th>
                    <Th className="hidden lg:table-cell">Notes</Th>
                    <Th>
                      <span className="sr-only">Delete</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {[...txs].reverse().map((t) => (
                    <tr key={t.id}>
                      <Td className="whitespace-nowrap">{formatDate(t.date)}</Td>
                      <Td>{TYPE_LABEL[t.type] ?? t.type}</Td>
                      <Td className="font-mono">{t.ticker ?? ""}</Td>
                      <Td numeric>{qty(t.quantity)}</Td>
                      <Td numeric>{t.price === null ? "—" : formatPrice(t.price)}</Td>
                      <Td numeric>{t.amount === null ? "—" : formatPrice(t.amount)}</Td>
                      <Td numeric className="hidden md:table-cell">
                        {t.fees ? formatPrice(t.fees) : "—"}
                      </Td>
                      <Td className="hidden max-w-60 truncate text-muted-foreground lg:table-cell">
                        {t.notes ?? ""}
                      </Td>
                      <Td>
                        <form action={deleteTransaction}>
                          <input type="hidden" name="id" value={selected.id} />
                          <input type="hidden" name="tx" value={t.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete ${TYPE_LABEL[t.type] ?? t.type} ${t.ticker ?? ""} on ${formatDate(t.date)}`}
                          >
                            Delete
                          </Button>
                        </form>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
