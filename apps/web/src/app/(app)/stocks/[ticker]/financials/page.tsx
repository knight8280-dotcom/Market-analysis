import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import {
  STATEMENTS,
  type Frequency,
  type LineValue,
  type StatementKind,
} from "@market/market-data/statements";
import { cn, EmptyState, formatDate } from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "../../../../../server/auth/owner";
import { db } from "../../../../../server/db";
import { filingUrl, statementColumns } from "../../../../../server/financials";
import { assertDisplayable, sourceInfo } from "../../../../../server/market";
import { securityForTicker, tickerOf } from "../../../../../server/stock";

type Params = Promise<{ ticker: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: `${tickerOf((await params).ticker)} financials` };
}

const KINDS: StatementKind[] = ["income", "balance", "cashflow"];
const LIMIT: Record<Frequency, number> = { annual: 10, quarterly: 12 };

/** USD in millions, per-share in dollars, share counts in millions; exact value in the title. */
function display(v: LineValue): string {
  const n = Number(v.value);
  const fmt = (x: number, digits: number) =>
    new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
      .format(x)
      .replace("-", "−");
  if (v.unit === "USD/shares") return fmt(n, 2);
  const m = n / 1e6;
  return fmt(m, Math.abs(m) >= 100 ? 0 : Math.abs(m) >= 1 ? 1 : 2);
}

function exact(v: LineValue): string {
  const [int = "0", frac] = v.value.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = v.value.startsWith("-") ? "−" : "";
  const prefix = v.unit === "shares" ? "" : "$";
  return `${sign}${prefix}${grouped}${frac ? `.${frac}` : ""}${v.unit === "shares" ? " shares" : ""}`;
}

function periodLabel(fy: number, fp: string) {
  return fp === "FY" ? `FY${fy}` : `${fp} FY${fy}`;
}

/**
 * Financials tab (Phase 1 step E3): statements built from SEC XBRL facts. Every value can be
 * traced: its title shows the exact figure, concept and filing; the footer links each period's
 * filing. "R" marks a value restated since first reported, "d" a derived value.
 */
export default async function FinancialsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  const ticker = tickerOf((await params).ticker);
  const security = await securityForTicker(ticker);
  if (!security) notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const kind = (KINDS as string[]).includes(one("statement") ?? "")
    ? (one("statement") as StatementKind)
    : "income";
  const frequency: Frequency = one("freq") === "quarterly" ? "quarterly" : "annual";
  const basis = one("basis") === "as_reported" ? "as_reported" : "latest";

  if (!security.cik) {
    return (
      <EmptyState title="No SEC filings for this security">
        Financial statements come from SEC EDGAR, and this security has no SEC registrant (ETFs,
        funds and synthetic test securities do not).
      </EmptyState>
    );
  }
  assertDisplayable("sec_edgar", "fundamentals", loadWebEnv().APP_ENV);
  const def = STATEMENTS.find((s) => s.kind === kind)!;
  const columns = await statementColumns(db(), security.cik, kind, frequency, LIMIT[frequency]);
  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ statement: kind, freq: frequency, basis, ...patch });
    return `/stocks/${encodeURIComponent(security.ticker)}/financials?${params.toString()}`;
  };
  const latestFiled = columns
    .flatMap((c) => Object.values(c.latest).map((v) => v.filed))
    .sort()
    .at(-1);
  const lines = def.lines.filter((l) => columns.some((c) => c.latest[l.id]));

  const Toggle = ({ items }: { items: { label: string; href: string; active: boolean }[] }) => (
    <div className="flex gap-1">
      {items.map((i) => (
        <Link
          key={i.label}
          href={i.href}
          aria-current={i.active ? "true" : undefined}
          className={cn(
            "flex min-h-8 items-center rounded-md px-2.5 text-sm hover:bg-muted",
            i.active && "bg-muted font-medium",
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <nav aria-label="Statement">
          <Toggle
            items={STATEMENTS.map((s) => ({
              label: s.label,
              href: href({ statement: s.kind }),
              active: s.kind === kind,
            }))}
          />
        </nav>
        <nav aria-label="Period">
          <Toggle
            items={[
              { label: "Annual", href: href({ freq: "annual" }), active: frequency === "annual" },
              {
                label: "Quarterly",
                href: href({ freq: "quarterly" }),
                active: frequency === "quarterly",
              },
            ]}
          />
        </nav>
        <nav aria-label="Basis">
          <Toggle
            items={[
              { label: "Latest", href: href({ basis: "latest" }), active: basis === "latest" },
              {
                label: "As first reported",
                href: href({ basis: "as_reported" }),
                active: basis === "as_reported",
              },
            ]}
          />
        </nav>
      </div>

      {columns.length === 0 ? (
        <EmptyState title="No statements yet">
          Statements are built after the registrant&apos;s XBRL facts load (
          <code>pnpm worker edgar</code>, then <code>pnpm worker statements</code>).
        </EmptyState>
      ) : (
        <>
          <div
            tabIndex={0}
            role="region"
            aria-label={`${def.label}, ${frequency}`}
            className="overflow-x-auto rounded-lg border bg-surface"
          >
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                {security.name} {def.label.toLowerCase()}, {frequency}, USD millions except
                per-share data, {basis === "latest" ? "latest values" : "as first reported"}
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 border-b bg-surface px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                  >
                    USD millions
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.periodEnd}
                      scope="col"
                      className="border-b px-3 py-2 text-right text-xs font-medium whitespace-nowrap"
                    >
                      {periodLabel(c.fiscalYear, c.fiscalPeriod)}
                      <span className="block font-normal text-muted-foreground">
                        {formatDate(c.periodEnd)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className={cn(line.total && "font-semibold")}>
                    <th
                      scope="row"
                      className={cn(
                        "sticky left-0 z-10 border-b border-border/60 bg-surface px-3 py-1.5 text-left whitespace-nowrap",
                        line.total ? "font-semibold" : "font-normal",
                      )}
                    >
                      {line.label}
                      {line.unit === "USD/shares" ? (
                        <span className="text-xs font-normal text-muted-foreground"> ($)</span>
                      ) : null}
                    </th>
                    {columns.map((c) => {
                      const v = (basis === "latest" ? c.latest : c.asReported)[line.id];
                      const other = (basis === "latest" ? c.asReported : c.latest)[line.id];
                      const restated = v && other && v.value !== other.value;
                      return (
                        <td
                          key={c.periodEnd}
                          className="border-b border-border/60 px-3 py-1.5 text-right whitespace-nowrap"
                          title={
                            v
                              ? `${exact(v)} · ${v.concept} · filed ${v.filed} (${v.accession})${v.derived ? ` · derived: ${v.derived}` : ""}${restated ? ` · ${basis === "latest" ? "first reported" : "now"} ${exact(other)}` : ""}`
                              : undefined
                          }
                        >
                          {v ? display(v) : <span className="text-muted-foreground">—</span>}
                          {restated ? (
                            <sup className="ml-0.5 text-warning">
                              R<span className="sr-only"> (restated)</span>
                            </sup>
                          ) : null}
                          {v?.derived ? (
                            <sup className="ml-0.5 text-muted-foreground">
                              d<span className="sr-only"> (derived: {v.derived})</span>
                            </sup>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-surface px-3 py-2 text-left text-xs font-normal text-muted-foreground"
                  >
                    Filing
                  </th>
                  {columns.map((c) => {
                    const items = basis === "latest" ? c.latest : c.asReported;
                    const first = lines.map((l) => items[l.id]).find(Boolean);
                    return (
                      <td
                        key={c.periodEnd}
                        className="px-3 py-2 text-right text-xs whitespace-nowrap"
                      >
                        {first ? (
                          <a
                            href={filingUrl(security.cik!, first.accession)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline underline-offset-2"
                          >
                            {formatDate(first.filed)}
                          </a>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p>
              USD millions except per-share data. <span className="text-warning">R</span>: changed
              since first reported (switch to &quot;As first reported&quot; to compare). d: derived
              from reported values (for example Q4 = FY − 9M YTD). Hover a value for the exact
              figure, its XBRL concept and filing. Blank: not reported with a standard tag.
            </p>
            <DataLabel source={sourceInfo("sec_edgar")} kind="filing" asOf={latestFiled ?? null} />
          </div>
        </>
      )}
    </div>
  );
}
