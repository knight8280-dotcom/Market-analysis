import { marketDateOf } from "@market/calendar";
import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import { Card, CardContent, CardHeader, formatDate, formatPercent } from "@market/ui";
import { DcfInputs } from "@market/valuation";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DcfCalculator,
  type FormValues,
  type ScenarioItem,
  type Sources,
} from "../../../../../components/valuation/dcf-calculator";
import { MultiplesSection } from "../../../../../components/valuation/multiples";
import { requireOwner } from "../../../../../server/auth/owner";
import { db } from "../../../../../server/db";
import { requireFlag } from "../../../../../server/flags";
import { assertDisplayable, priceSource, sourceInfo } from "../../../../../server/market";
import { securityForTicker, tickerOf } from "../../../../../server/stock";
import { scenariosFor, valuationView, type Sourced } from "../../../../../server/valuation";
import { deleteScenario, saveScenario } from "./actions";

type Params = Promise<{ ticker: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: `${tickerOf((await params).ticker)} valuation` };
}

const pct = (s: Sourced | null) => (s ? String(Number((s.value * 100).toFixed(2))) : "");
const mil = (s: Sourced | null) => (s ? String(Number((s.value / 1e6).toFixed(2))) : "");

function from(s: Sourced | null): string | undefined {
  if (!s) return undefined;
  const span =
    s.basis === "four_quarters"
      ? `four quarters to ${formatDate(s.periodEnd)}`
      : s.basis === "fiscal_year"
        ? `fiscal year to ${formatDate(s.periodEnd)}`
        : s.basis === "ratio"
          ? `latest figures to ${formatDate(s.periodEnd)}`
          : `as of ${formatDate(s.periodEnd)}`;
  return `From filings: ${span}, filed ${formatDate(s.filed)}`;
}

/** Valuation tab (Phase 2 steps D2 and D3): DCF calculator, peers and multiple history. */
export default async function ValuationPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  await requireFlag("valuation");
  const ticker = tickerOf((await params).ticker);
  const security = await securityForTicker(ticker);
  if (!security) notFound();
  const q = await searchParams;
  const peersParam = typeof q.peers === "string" ? q.peers : "";
  const customPeers = peersParam.trim()
    ? [
        ...new Set(
          peersParam
            .split(/[\s,]+/)
            .map((t) => t.trim().toUpperCase())
            .filter((t) => /^[A-Z0-9._-]{1,15}$/.test(t) && t !== security.ticker),
        ),
      ].slice(0, 20)
    : null;

  const database = db();
  const source = await priceSource(database);
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const asOf = marketDateOf(new Date());
  const [view, saved] = await Promise.all([
    valuationView(database, source, security, { asOf, customPeers }),
    scenariosFor(database, security.securityId),
  ]);
  const f = view.figures;

  const initial: FormValues = {
    revenue0: mil(f?.revenueTtm ?? null),
    years: "5",
    growth: "5",
    ebitMargin: pct(f?.ebitMargin ?? null),
    taxRate: f?.taxRate ? pct(f.taxRate) : "21",
    daPct: pct(f?.daPct ?? null),
    capexPct: pct(f?.capexPct ?? null),
    nwcPct: "0",
    wacc: "9",
    method: "growth",
    terminalGrowth: "2.5",
    evEbitda: view.stats.evEbitda.median
      ? String(Number(view.stats.evEbitda.median.toFixed(1)))
      : "12",
    netDebt: mil(f?.netDebt ?? null),
    shares: mil(f?.shares ?? null),
  };
  const sources: Sources = {
    revenue0: from(f?.revenueTtm ?? null),
    growth: f?.revenueGrowth
      ? `Your assumption. Last year: ${formatPercent(f.revenueGrowth.value, 1)}`
      : undefined,
    ebitMargin: from(f?.ebitMargin ?? null),
    taxRate: f?.taxRate ? from(f.taxRate) : "Your assumption (US federal rate)",
    daPct: from(f?.daPct ?? null),
    capexPct: from(f?.capexPct ?? null),
    netDebt: f?.netDebt ? `${from(f.netDebt)}; long-term debt less cash` : undefined,
    shares: from(f?.shares ?? null),
    evEbitda: view.stats.evEbitda.median ? "Your assumption; starts at the peer median" : undefined,
  };
  const scenarios: ScenarioItem[] = saved.map((s) => {
    const parsed = DcfInputs.safeParse(s.inputs);
    return { id: s.id, name: s.name, inputs: parsed.success ? parsed.data : null };
  });
  const latestFiled = f
    ? (Object.values(f) as (Sourced | null)[])
        .map((v) => v?.filed ?? "")
        .sort()
        .at(-1) || null
    : null;
  const filingsLabel = latestFiled ? (
    <DataLabel
      source={{ name: "SEC EDGAR", attribution: "Company filings via SEC EDGAR (public domain)" }}
      kind="filing"
      asOf={latestFiled}
    />
  ) : null;
  const priceLabel =
    source && view.price ? (
      <DataLabel source={sourceInfo(source)} kind="eod" asOf={view.price.date} />
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Discounted cash flow"
          description={
            <span className="flex flex-col gap-0.5">
              <span>
                {f
                  ? "Inputs start from the latest filings where they exist; every one is editable."
                  : "No SEC filings for this security: enter every input yourself."}
              </span>
              {filingsLabel}
              {priceLabel}
            </span>
          }
        />
        <CardContent>
          <DcfCalculator
            initial={initial}
            sources={sources}
            price={view.price}
            scenarios={scenarios}
            securityId={security.securityId}
            saveAction={saveScenario}
            deleteAction={deleteScenario}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="Multiples"
          description={
            <span className="flex flex-col gap-0.5">
              <span>
                Where this company&apos;s price sits relative to its earnings, sales and EBITDA,
                next to similar companies.
              </span>
              {filingsLabel}
              {priceLabel}
            </span>
          }
        />
        <CardContent>
          <MultiplesSection view={view} ticker={security.ticker} customPeers={customPeers} />
        </CardContent>
      </Card>
    </div>
  );
}
