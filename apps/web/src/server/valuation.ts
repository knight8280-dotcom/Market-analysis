import "server-only";
import { addDays, tradingDaysBetween } from "@market/calendar";
import { OWNER_USER_ID } from "@market/config";
import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";
import type { LineValue } from "@market/market-data/statements";
import {
  latestAsOf,
  median,
  monthEnds,
  multiples,
  nearestByMarketCap,
  percentileRank,
  ttmAsOf,
  type KnownValue,
  type Multiples,
  type PeriodValue,
} from "@market/valuation";

/**
 * Valuation tab data (Phase 2 steps D2 and D3): calculator inputs from the filings with their
 * sources, peers' multiples, and the subject's multiples over five years as they were known.
 */

const LINES = {
  income: ["revenue", "operatingIncome", "pretaxIncome", "incomeTax", "netIncome", "sharesDiluted"],
  cashflow: ["depreciation", "capex"],
  balance: ["cash", "shortTermInvestments", "longTermDebt", "sharesOutstanding"],
} as const;
type Line =
  (typeof LINES.income)[number] | (typeof LINES.cashflow)[number] | (typeof LINES.balance)[number];

type Rows = Record<Line, PeriodValue[]>;

const emptyRows = (): Rows =>
  Object.fromEntries(
    [...LINES.income, ...LINES.cashflow, ...LINES.balance].map((l) => [l, []]),
  ) as unknown as Rows;

/** Statement values per line and CIK, on one basis ("latest" includes restatements). */
async function statementRows(
  db: Database,
  ciks: readonly string[],
  basis: "latest" | "as_reported",
): Promise<Map<string, Rows>> {
  const out = new Map<string, Rows>();
  if (ciks.length === 0) return out;
  const rows = await db
    .selectFrom("market.financial_statements")
    .select(["cik", "statement", "frequency", "period_end", "line_items"])
    .where("cik", "in", [...ciks])
    .where("basis", "=", basis)
    .orderBy("period_end")
    .execute();
  for (const r of rows) {
    const byLine = out.get(r.cik) ?? emptyRows();
    const items = r.line_items as unknown as Record<string, LineValue | undefined>;
    const lines = LINES[r.statement as keyof typeof LINES] ?? [];
    for (const line of lines) {
      const v = items[line];
      byLine[line].push({
        frequency: r.frequency as PeriodValue["frequency"],
        periodEnd: r.period_end,
        value: v ? { value: Number(v.value), filed: v.filed } : null,
      });
    }
    out.set(r.cik, byLine);
  }
  return out;
}

export interface Sourced {
  value: number;
  /** How the value was formed, for its label: "TTM to Jun 30, 2026", "as of Jun 30, 2026". */
  periodEnd: string;
  filed: string;
  basis: KnownValue["basis"] | "ratio";
}

const known = (k: KnownValue | null): Sourced | null =>
  k ? { value: k.value, periodEnd: k.periodEnd, filed: k.filed, basis: k.basis } : null;
const ratio = (a: Sourced | null, b: Sourced | null): Sourced | null =>
  a && b && b.value > 0
    ? {
        value: a.value / b.value,
        periodEnd: a.periodEnd < b.periodEnd ? a.periodEnd : b.periodEnd,
        filed: a.filed > b.filed ? a.filed : b.filed,
        // A ratio of two figures over the same span reads as that span.
        basis: a.basis === b.basis ? a.basis : "ratio",
      }
    : null;

export interface FilingFigures {
  revenueTtm: Sourced | null;
  revenueGrowth: Sourced | null;
  ebitMargin: Sourced | null;
  taxRate: Sourced | null;
  daPct: Sourced | null;
  capexPct: Sourced | null;
  netIncomeTtm: Sourced | null;
  ebitdaTtm: Sourced | null;
  netDebt: Sourced | null;
  shares: Sourced | null;
}

/** Calculator inputs and multiple inputs from one company's statements, as known on `asOf`. */
function figures(rows: Rows, asOf: string): FilingFigures {
  const ttm = (line: Line) => known(ttmAsOf(rows[line], asOf));
  const revenue = ttm("revenue");
  const yearAgo = revenue
    ? known(ttmAsOf(rows.revenue, asOf, { through: addDays(revenue.periodEnd, -355) }))
    : null;
  const operating = ttm("operatingIncome");
  const depreciation = ttm("depreciation");
  const pretax = ttm("pretaxIncome");
  const tax = ttm("incomeTax");
  const cash = known(latestAsOf(rows.cash, asOf));
  const sti = known(latestAsOf(rows.shortTermInvestments, asOf));
  const debt = known(latestAsOf(rows.longTermDebt, asOf));
  const taxRate = ratio(tax, pretax);
  return {
    revenueTtm: revenue,
    revenueGrowth:
      revenue && yearAgo && yearAgo.value > 0
        ? { ...revenue, value: revenue.value / yearAgo.value - 1, basis: "ratio" }
        : null,
    ebitMargin: ratio(operating, revenue),
    taxRate: taxRate && taxRate.value >= 0 && taxRate.value <= 0.6 ? taxRate : null,
    daPct: ratio(depreciation, revenue),
    capexPct: ratio(ttm("capex"), revenue),
    netIncomeTtm: ttm("netIncome"),
    ebitdaTtm:
      operating && depreciation
        ? {
            ...operating,
            value: operating.value + depreciation.value,
            filed: operating.filed > depreciation.filed ? operating.filed : depreciation.filed,
          }
        : null,
    // Long-term debt less cash and short-term investments; unavailable without both debt and
    // cash (a missing figure is never taken as zero).
    netDebt:
      debt && cash
        ? {
            value: debt.value - cash.value - (sti?.value ?? 0),
            periodEnd: debt.periodEnd,
            filed: [debt.filed, cash.filed, sti?.filed ?? ""].sort().at(-1)!,
            basis: "period",
          }
        : null,
    shares:
      known(latestAsOf(rows.sharesDiluted, asOf)) ??
      known(latestAsOf(rows.sharesOutstanding, asOf)),
  };
}

export interface PriceNow {
  close: number;
  date: string;
}

async function latestCloses(
  db: Database,
  source: ProviderId,
  securityIds: readonly string[],
): Promise<Map<string, PriceNow>> {
  if (securityIds.length === 0) return new Map();
  const rows = await sql<{ security_id: string; date: string; close: number }>`
    select distinct on (security_id) security_id, date, close::float8 as close
    from market.prices_daily
    where source = ${source} and security_id = any(${[...securityIds]}::bigint[])
    order by security_id, date desc
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.security_id, { close: r.close, date: r.date }]));
}

export interface PeerRow {
  securityId: string;
  ticker: string;
  name: string;
  price: PriceNow | null;
  multiples: Multiples;
  figures: FilingFigures | null;
}

export interface ValuationView {
  figures: FilingFigures | null;
  price: PriceNow | null;
  subject: PeerRow;
  peers: PeerRow[];
  /** How peers were chosen: an industry, or the owner's own list. */
  peerBasis: { kind: "sic" | "industry" | "custom" | "none"; label: string | null };
  stats: Record<"pe" | "ps" | "evEbitda", { median: number | null; percentile: number | null }>;
  history: MultipleHistory | null;
}

export interface MultipleHistory {
  dates: string[];
  pe: (number | null)[];
  ps: (number | null)[];
  evEbitda: (number | null)[];
  /** Where today's multiple sits in its own five-year range (0 to 1), and the range's median. */
  summary: Record<"pe" | "ps" | "evEbitda", { median: number | null; percentile: number | null }>;
}

interface SecurityRef {
  securityId: string;
  ticker: string;
  name: string;
  cik: string | null;
  sicCode: string | null;
  industry: string | null;
}

/** Peer candidates: same SIC code, else the same industry, with SEC filings. */
async function peerCandidates(db: Database, subject: SecurityRef, custom: string[] | null) {
  const base = db
    .selectFrom("market.securities as s")
    .leftJoin("market.screener_snapshot as x", "x.security_id", "s.security_id")
    .select([
      "s.security_id",
      "s.ticker",
      "s.name",
      "s.cik",
      "s.sic_code",
      "s.industry",
      "x.market_cap",
    ])
    .where("s.is_active", "=", true)
    .where("s.security_id", "!=", subject.securityId);
  if (custom) {
    const rows = await base.where("s.ticker", "in", custom.length ? custom : ["-"]).execute();
    return { rows, basis: { kind: "custom" as const, label: null } };
  }
  if (subject.sicCode) {
    const rows = await base
      .where("s.sic_code", "=", subject.sicCode)
      .where("s.cik", "is not", null)
      .execute();
    if (rows.length)
      return { rows, basis: { kind: "sic" as const, label: `SIC ${subject.sicCode}` } };
  }
  if (subject.industry) {
    const rows = await base
      .where("s.industry", "=", subject.industry)
      .where("s.cik", "is not", null)
      .execute();
    if (rows.length) return { rows, basis: { kind: "industry" as const, label: subject.industry } };
  }
  return { rows: [], basis: { kind: "none" as const, label: null } };
}

const MULTIPLES = ["pe", "ps", "evEbitda"] as const;

function rowFor(ref: SecurityRef, price: PriceNow | null, f: FilingFigures | null): PeerRow {
  return {
    securityId: ref.securityId,
    ticker: ref.ticker,
    name: ref.name,
    price,
    figures: f,
    multiples: multiples({
      price: price?.close ?? null,
      shares: f?.shares?.value ?? null,
      revenueTtm: f?.revenueTtm?.value ?? null,
      netIncomeTtm: f?.netIncomeTtm?.value ?? null,
      ebitdaTtm: f?.ebitdaTtm?.value ?? null,
      netDebt: f?.netDebt?.value ?? null,
    }),
  };
}

export const PEER_LIMIT = 8;

export async function valuationView(
  db: Database,
  source: ProviderId | null,
  subject: SecurityRef,
  opts: { asOf: string; customPeers: string[] | null },
): Promise<ValuationView> {
  const { rows: candidates, basis } = await peerCandidates(db, subject, opts.customPeers);
  const subjectCap = candidates.length
    ? ((
        await db
          .selectFrom("market.screener_snapshot")
          .select("market_cap")
          .where("security_id", "=", subject.securityId)
          .executeTakeFirst()
      )?.market_cap ?? null)
    : null;
  const chosen = opts.customPeers
    ? candidates
    : nearestByMarketCap(
        { id: subject.securityId, marketCap: subjectCap },
        candidates.map((c) => ({ ...c, id: c.security_id, marketCap: c.market_cap })),
        PEER_LIMIT,
      );

  const ciks = [subject.cik, ...chosen.map((c) => c.cik)].filter((c): c is string => c !== null);
  const [latest, prices] = await Promise.all([
    statementRows(db, ciks, "latest"),
    source
      ? latestCloses(db, source, [subject.securityId, ...chosen.map((c) => c.security_id)])
      : Promise.resolve(new Map<string, PriceNow>()),
  ]);
  const figuresOf = (cik: string | null) => {
    const r = cik ? latest.get(cik) : undefined;
    return r ? figures(r, opts.asOf) : null;
  };
  const subjectFigures = figuresOf(subject.cik);
  const subjectRow = rowFor(subject, prices.get(subject.securityId) ?? null, subjectFigures);
  const peers = chosen.map((c) =>
    rowFor(
      {
        securityId: c.security_id,
        ticker: c.ticker,
        name: c.name,
        cik: c.cik,
        sicCode: c.sic_code,
        industry: c.industry,
      },
      prices.get(c.security_id) ?? null,
      figuresOf(c.cik),
    ),
  );
  const stats = Object.fromEntries(
    MULTIPLES.map((m) => {
      const values = peers.map((p) => p.multiples[m]);
      return [
        m,
        { median: median(values), percentile: percentileRank(subjectRow.multiples[m], values) },
      ];
    }),
  ) as ValuationView["stats"];

  return {
    figures: subjectFigures,
    price: subjectRow.price,
    subject: subjectRow,
    peers,
    peerBasis: basis,
    stats,
    history: source && subject.cik ? await multipleHistory(db, source, subject, opts.asOf) : null,
  };
}

/**
 * The subject's month-end multiples over five years, each from figures as first reported and
 * known by that date, and the closing price that day (shares adjusted for later splits).
 */
async function multipleHistory(
  db: Database,
  source: ProviderId,
  subject: SecurityRef,
  asOf: string,
): Promise<MultipleHistory | null> {
  const from = addDays(asOf, -5 * 365 - 10);
  const [reported, bars, splits] = await Promise.all([
    statementRows(db, [subject.cik!], "as_reported"),
    sql<{ date: string; close: number }>`
      select date, close::float8 as close from market.prices_daily
      where security_id = ${subject.securityId} and source = ${source}
        and date between ${from}::date and ${asOf}::date
      order by date
    `.execute(db),
    db
      .selectFrom("market.corporate_actions")
      .select(["ex_date", "ratio"])
      .where("security_id", "=", subject.securityId)
      .where("source", "=", source)
      .where("type", "in", ["split", "stock_dividend"])
      .execute(),
  ]);
  const rows = reported.get(subject.cik!);
  if (!rows || bars.rows.length < 2) return null;
  const closes = new Map(bars.rows.map((b) => [b.date, b.close]));
  const sessions = tradingDaysBetween(bars.rows[0]!.date, bars.rows.at(-1)!.date).filter((d) =>
    closes.has(d),
  );
  const dates = monthEnds(sessions);
  const points = dates.map((d) => {
    const f = figures(rows, d);
    // Shares as of their period end, multiplied by splits since then.
    const shares = f.shares
      ? splits
          .filter((s) => s.ex_date > f.shares!.periodEnd && s.ex_date <= d)
          .reduce((n, s) => n * Number(s.ratio), f.shares.value)
      : null;
    return multiples({
      price: closes.get(d) ?? null,
      shares,
      revenueTtm: f.revenueTtm?.value ?? null,
      netIncomeTtm: f.netIncomeTtm?.value ?? null,
      ebitdaTtm: f.ebitdaTtm?.value ?? null,
      netDebt: f.netDebt?.value ?? null,
    });
  });
  const series = (m: (typeof MULTIPLES)[number]) => points.map((p) => p[m]);
  const summary = Object.fromEntries(
    MULTIPLES.map((m) => {
      const values = series(m);
      const current = values.at(-1) ?? null;
      return [
        m,
        { median: median(values), percentile: percentileRank(current, values.slice(0, -1)) },
      ];
    }),
  ) as MultipleHistory["summary"];
  if (MULTIPLES.every((m) => series(m).every((v) => v === null))) return null;
  return { dates, pe: series("pe"), ps: series("ps"), evEbitda: series("evEbitda"), summary };
}

export interface SavedScenario {
  id: string;
  name: string;
  inputs: unknown;
  updatedAt: Date;
}

export async function scenariosFor(db: Database, securityId: string): Promise<SavedScenario[]> {
  const rows = await db
    .selectFrom("valuation_scenarios")
    .select(["scenario_id", "name", "inputs", "updated_at"])
    .where("user_id", "=", OWNER_USER_ID)
    .where("security_id", "=", securityId)
    .orderBy("name")
    .execute();
  return rows.map((r) => ({
    id: r.scenario_id,
    name: r.name,
    inputs: r.inputs,
    updatedAt: new Date(r.updated_at),
  }));
}
