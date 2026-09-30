/**
 * Financial statements from XBRL facts (Phase 1 step E).
 *
 * - Periods come from each filing's own reporting period: the latest ~1-year period in a 10-K
 *   (fiscal_period FY) and the latest ~3-month period in a 10-Q. A fact's fy/fp describe the
 *   filing it came from, not the fact's period (a 10-K repeats the prior year as a comparative),
 *   so values are matched to periods by their dates.
 * - Each line lists candidate concepts in order; per period, the first concept with a value wins,
 *   and the concept used is recorded with the value.
 * - "latest" takes each value from the most recent filing that reported it for that exact
 *   period (so restatements apply); "as_reported" from the earliest.
 * - Quarterly flow values not reported for the quarter itself are derived from year-to-date
 *   values (Q2 = 6M − 3M, Q3 = 9M − 6M, Q4 = FY − 9M) with the same concept, and are marked
 *   derived. Per-share and weighted-share lines are never derived. Nothing is estimated.
 */

export type StatementKind = "income" | "balance" | "cashflow";
export type Frequency = "annual" | "quarterly";
export type Basis = "latest" | "as_reported";
export type FiscalPeriod = "FY" | "Q1" | "Q2" | "Q3" | "Q4";

export interface LineDef {
  id: string;
  label: string;
  /** "taxonomy:Concept", in order of preference. */
  concepts: readonly string[];
  unit: "USD" | "USD/shares" | "shares";
  /** False for per-share values and weighted averages, which cannot be summed or differenced. */
  additive?: boolean;
  /** Displayed bold (totals). */
  total?: boolean;
}

export interface StatementDef {
  kind: StatementKind;
  label: string;
  /** Flows cover a duration; the balance sheet is a point in time. */
  period: "duration" | "instant";
  lines: readonly LineDef[];
}

const g = (...names: string[]) => names.map((n) => (n.includes(":") ? n : `us-gaap:${n}`));

export const STATEMENTS: readonly StatementDef[] = [
  {
    kind: "income",
    label: "Income statement",
    period: "duration",
    lines: [
      {
        id: "revenue",
        label: "Revenue",
        unit: "USD",
        total: true,
        concepts: g(
          "RevenueFromContractWithCustomerExcludingAssessedTax",
          "Revenues",
          "SalesRevenueNet",
          "RevenueFromContractWithCustomerIncludingAssessedTax",
          "SalesRevenueGoodsNet",
          // Banks and brokers: total net revenue.
          "RevenuesNetOfInterestExpense",
        ),
      },
      {
        id: "costOfRevenue",
        label: "Cost of revenue",
        unit: "USD",
        concepts: g("CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"),
      },
      {
        id: "grossProfit",
        label: "Gross profit",
        unit: "USD",
        total: true,
        concepts: g("GrossProfit"),
      },
      {
        id: "researchAndDevelopment",
        label: "Research and development",
        unit: "USD",
        concepts: g(
          "ResearchAndDevelopmentExpense",
          "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
        ),
      },
      {
        id: "sellingGeneralAdministrative",
        label: "Selling, general and administrative",
        unit: "USD",
        concepts: g("SellingGeneralAndAdministrativeExpense"),
      },
      {
        id: "operatingExpenses",
        label: "Total operating expenses",
        unit: "USD",
        concepts: g("OperatingExpenses", "CostsAndExpenses"),
      },
      {
        id: "operatingIncome",
        label: "Operating income",
        unit: "USD",
        total: true,
        concepts: g("OperatingIncomeLoss"),
      },
      {
        id: "interestExpense",
        label: "Interest expense",
        unit: "USD",
        concepts: g("InterestExpense", "InterestExpenseNonoperating"),
      },
      {
        id: "pretaxIncome",
        label: "Income before taxes",
        unit: "USD",
        concepts: g(
          "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
          "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
        ),
      },
      { id: "incomeTax", label: "Income tax", unit: "USD", concepts: g("IncomeTaxExpenseBenefit") },
      {
        id: "netIncome",
        label: "Net income",
        unit: "USD",
        total: true,
        // ProfitLoss (which includes noncontrolling interests) only when nothing else is reported.
        concepts: g(
          "NetIncomeLoss",
          "NetIncomeLossAvailableToCommonStockholdersBasic",
          "ProfitLoss",
        ),
      },
      {
        id: "epsBasic",
        label: "EPS, basic",
        unit: "USD/shares",
        additive: false,
        concepts: g("EarningsPerShareBasic"),
      },
      {
        id: "epsDiluted",
        label: "EPS, diluted",
        unit: "USD/shares",
        additive: false,
        concepts: g("EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"),
      },
      {
        id: "sharesBasic",
        label: "Weighted shares, basic",
        unit: "shares",
        additive: false,
        concepts: g("WeightedAverageNumberOfSharesOutstandingBasic"),
      },
      {
        id: "sharesDiluted",
        label: "Weighted shares, diluted",
        unit: "shares",
        additive: false,
        concepts: g("WeightedAverageNumberOfDilutedSharesOutstanding"),
      },
    ],
  },
  {
    kind: "balance",
    label: "Balance sheet",
    period: "instant",
    lines: [
      {
        id: "cash",
        label: "Cash and equivalents",
        unit: "USD",
        concepts: g(
          "CashAndCashEquivalentsAtCarryingValue",
          "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        ),
      },
      {
        id: "shortTermInvestments",
        label: "Short-term investments",
        unit: "USD",
        concepts: g("MarketableSecuritiesCurrent", "ShortTermInvestments"),
      },
      {
        id: "receivables",
        label: "Accounts receivable",
        unit: "USD",
        concepts: g("AccountsReceivableNetCurrent"),
      },
      { id: "inventory", label: "Inventory", unit: "USD", concepts: g("InventoryNet") },
      {
        id: "currentAssets",
        label: "Total current assets",
        unit: "USD",
        total: true,
        concepts: g("AssetsCurrent"),
      },
      {
        id: "ppe",
        label: "Property, plant and equipment",
        unit: "USD",
        concepts: g("PropertyPlantAndEquipmentNet"),
      },
      { id: "goodwill", label: "Goodwill", unit: "USD", concepts: g("Goodwill") },
      { id: "totalAssets", label: "Total assets", unit: "USD", total: true, concepts: g("Assets") },
      {
        id: "accountsPayable",
        label: "Accounts payable",
        unit: "USD",
        concepts: g("AccountsPayableCurrent"),
      },
      {
        id: "currentLiabilities",
        label: "Total current liabilities",
        unit: "USD",
        total: true,
        concepts: g("LiabilitiesCurrent"),
      },
      {
        id: "longTermDebt",
        label: "Long-term debt",
        unit: "USD",
        concepts: g("LongTermDebtNoncurrent", "LongTermDebt"),
      },
      {
        id: "totalLiabilities",
        label: "Total liabilities",
        unit: "USD",
        total: true,
        concepts: g("Liabilities"),
      },
      {
        id: "equity",
        label: "Shareholders' equity",
        unit: "USD",
        total: true,
        concepts: g(
          "StockholdersEquity",
          "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        ),
      },
      {
        id: "liabilitiesAndEquity",
        label: "Total liabilities and equity",
        unit: "USD",
        total: true,
        concepts: g("LiabilitiesAndStockholdersEquity"),
      },
      {
        id: "sharesOutstanding",
        label: "Shares outstanding",
        unit: "shares",
        additive: false,
        concepts: g("CommonStockSharesOutstanding"),
      },
    ],
  },
  {
    kind: "cashflow",
    label: "Cash flow",
    period: "duration",
    lines: [
      {
        id: "operatingCashFlow",
        label: "Cash from operations",
        unit: "USD",
        total: true,
        concepts: g(
          "NetCashProvidedByUsedInOperatingActivities",
          "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        ),
      },
      {
        id: "depreciation",
        label: "Depreciation and amortization",
        unit: "USD",
        concepts: g(
          "DepreciationDepletionAndAmortization",
          "DepreciationAmortizationAndAccretionNet",
          "DepreciationAndAmortization",
        ),
      },
      {
        id: "stockCompensation",
        label: "Stock-based compensation",
        unit: "USD",
        concepts: g("ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"),
      },
      {
        id: "capex",
        label: "Capital expenditure",
        unit: "USD",
        concepts: g(
          "PaymentsToAcquirePropertyPlantAndEquipment",
          "PaymentsToAcquireProductiveAssets",
        ),
      },
      {
        id: "investingCashFlow",
        label: "Cash from investing",
        unit: "USD",
        total: true,
        concepts: g(
          "NetCashProvidedByUsedInInvestingActivities",
          "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
        ),
      },
      {
        id: "dividendsPaid",
        label: "Dividends paid",
        unit: "USD",
        concepts: g("PaymentsOfDividends", "PaymentsOfDividendsCommonStock"),
      },
      {
        id: "buybacks",
        label: "Share repurchases",
        unit: "USD",
        concepts: g("PaymentsForRepurchaseOfCommonStock"),
      },
      {
        id: "financingCashFlow",
        label: "Cash from financing",
        unit: "USD",
        total: true,
        concepts: g(
          "NetCashProvidedByUsedInFinancingActivities",
          "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
        ),
      },
      {
        id: "freeCashFlow",
        label: "Free cash flow (derived)",
        unit: "USD",
        total: true,
        concepts: [],
      },
    ],
  },
];

/** Every concept any line uses, for loading only the facts the builder needs. */
export const STATEMENT_CONCEPTS: readonly string[] = [
  ...new Set(STATEMENTS.flatMap((s) => s.lines.flatMap((l) => l.concepts))),
];

export interface FactRow {
  taxonomy: string;
  concept: string;
  unit: string;
  /** Decimal string, as stored (numeric). */
  value: string;
  period_start: string | null;
  period_end: string;
  fiscal_year: number | null;
  fiscal_period: string | null;
  form: string;
  filed_at: string;
  accession_no: string;
}

export interface LineValue {
  value: string;
  concept: string;
  unit: string;
  /** The filing the value (or, when derived, its first component) came from. */
  accession: string;
  filed: string;
  /** How a derived value was computed, e.g. "FY − 9M YTD". */
  derived?: string;
}

export interface StatementRow {
  statement: StatementKind;
  frequency: Frequency;
  basis: Basis;
  fiscalYear: number;
  fiscalPeriod: FiscalPeriod;
  periodStart: string | null;
  periodEnd: string;
  lineItems: Record<string, LineValue>;
  restated: boolean;
}

// --- Exact decimal arithmetic (values are decimal strings; floats would lose cents) --------

function parseDecimal(s: string): { n: bigint; scale: number } {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`Not a decimal: ${s}`);
  const frac = m[3] ?? "";
  return { n: BigInt(`${m[1]}${m[2]}${frac}`), scale: frac.length };
}

function formatDecimal(n: bigint, scale: number): string {
  const neg = n < 0n;
  let digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  if (scale > 0) {
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  }
  return `${neg && digits !== "0" ? "-" : ""}${digits}`;
}

export function decimalSub(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const nx = x.n * 10n ** BigInt(scale - x.scale);
  const ny = y.n * 10n ** BigInt(scale - y.scale);
  return formatDecimal(nx - ny, scale);
}

export function decimalAdd(a: string, b: string): string {
  return decimalSub(a, b.startsWith("-") ? b.slice(1) : `-${b}`);
}

// --- Periods ---------------------------------------------------------------------------------

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

type Span = "quarter" | "half" | "nine" | "year";
function spanOf(start: string, end: string): Span | null {
  const d = days(start, end);
  if (d >= 80 && d <= 100) return "quarter";
  if (d >= 170 && d <= 195) return "half";
  if (d >= 260 && d <= 285) return "nine";
  if (d >= 350 && d <= 380) return "year";
  return null;
}
const near = (a: string, b: string, tolerance = 7) => Math.abs(days(a, b)) <= tolerance;

interface Period {
  fiscalYear: number;
  fiscalPeriod: FiscalPeriod;
  start: string;
  end: string;
}

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "10-KT/A"]);
const QUARTERLY_FORMS = new Set(["10-Q", "10-Q/A"]);

/** Each filing's own reporting period: the latest year (10-K) or quarter (10-Q) it covers. */
export function reportingPeriods(facts: readonly FactRow[]): {
  annual: Period[];
  quarterly: Period[];
} {
  const byAccession = new Map<string, FactRow[]>();
  for (const f of facts) {
    if (!f.period_start || f.fiscal_year === null || !f.fiscal_period) continue;
    const list = byAccession.get(f.accession_no);
    if (list) list.push(f);
    else byAccession.set(f.accession_no, [f]);
  }
  const annual = new Map<string, Period>();
  const quarters = new Map<string, Period>();
  const accessions = [...byAccession.entries()].sort(
    (a, b) => a[1][0]!.filed_at.localeCompare(b[1][0]!.filed_at) || a[0].localeCompare(b[0]),
  );
  for (const [, list] of accessions) {
    const form = list[0]!.form;
    const annualForm = ANNUAL_FORMS.has(form);
    if (!annualForm && !QUARTERLY_FORMS.has(form)) continue;
    let best: FactRow | null = null;
    for (const f of list) {
      const span = spanOf(f.period_start!, f.period_end);
      const wanted = annualForm
        ? span === "year" && f.fiscal_period === "FY"
        : span === "quarter" && /^Q[123]$/.test(f.fiscal_period!);
      if (wanted && (!best || f.period_end > best.period_end)) best = f;
    }
    if (!best) continue;
    const target = annualForm ? annual : quarters;
    // The first filing to report a period names it; amendments keep that label.
    if (!target.has(best.period_end)) {
      target.set(best.period_end, {
        fiscalYear: best.fiscal_year!,
        fiscalPeriod: (annualForm ? "FY" : best.fiscal_period) as FiscalPeriod,
        start: best.period_start!,
        end: best.period_end,
      });
    }
  }
  const quarterly = [...quarters.values()];
  // Q4 is the part of each fiscal year after its Q3.
  for (const year of annual.values()) {
    const q3 = quarterly.find((q) => q.fiscalYear === year.fiscalYear && q.fiscalPeriod === "Q3");
    if (q3 && q3.end < year.end) {
      quarterly.push({
        fiscalYear: year.fiscalYear,
        fiscalPeriod: "Q4",
        start: addDays(q3.end, 1),
        end: year.end,
      });
    }
  }
  const byEnd = (a: Period, b: Period) => a.end.localeCompare(b.end);
  return { annual: [...annual.values()].sort(byEnd), quarterly: quarterly.sort(byEnd) };
}

// --- Values ----------------------------------------------------------------------------------

interface Picked {
  latest: FactRow;
  first: FactRow;
}

function order(a: FactRow, b: FactRow): number {
  return a.filed_at.localeCompare(b.filed_at) || a.accession_no.localeCompare(b.accession_no);
}

function pickFrom(candidates: FactRow[]): Picked | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(order);
  return { first: sorted[0]!, latest: sorted.at(-1)! };
}

function toValue(f: FactRow, derived?: string): LineValue {
  const v: LineValue = {
    value: f.value,
    concept: `${f.taxonomy}:${f.concept}`,
    unit: f.unit,
    accession: f.accession_no,
    filed: f.filed_at,
  };
  if (derived) v.derived = derived;
  return v;
}

const YTD_LABEL: Record<FiscalPeriod, string> = {
  Q1: "3M",
  Q2: "6M YTD",
  Q3: "9M YTD",
  Q4: "FY",
  FY: "FY",
};
const PREVIOUS: Partial<Record<FiscalPeriod, FiscalPeriod>> = { Q2: "Q1", Q3: "Q2", Q4: "Q3" };

class FactIndex {
  private readonly byConcept = new Map<string, FactRow[]>();

  constructor(facts: readonly FactRow[]) {
    for (const f of facts) {
      const key = `${f.taxonomy}:${f.concept}`;
      const list = this.byConcept.get(key);
      if (list) list.push(f);
      else this.byConcept.set(key, [f]);
    }
  }

  instant(concept: string, unit: string, end: string): Picked | null {
    return pickFrom(
      (this.byConcept.get(concept) ?? []).filter(
        (f) => f.unit === unit && f.period_start === null && f.period_end === end,
      ),
    );
  }

  duration(concept: string, unit: string, start: string, end: string): Picked | null {
    const span = spanOf(start, end);
    return pickFrom(
      (this.byConcept.get(concept) ?? []).filter(
        (f) =>
          f.unit === unit &&
          f.period_start !== null &&
          f.period_end === end &&
          spanOf(f.period_start, f.period_end) === span &&
          near(f.period_start, start),
      ),
    );
  }
}

type Both = { latest: LineValue; asReported: LineValue } | null;

function lineValue(
  index: FactIndex,
  def: StatementDef,
  line: LineDef,
  period: Period,
  frequency: Frequency,
  fiscalYearStart: (fy: number) => string | null,
  quarterOf: (fy: number, fp: FiscalPeriod) => Period | undefined,
): Both {
  for (const concept of line.concepts) {
    if (def.period === "instant") {
      const p = index.instant(concept, line.unit, period.end);
      if (p) return { latest: toValue(p.latest), asReported: toValue(p.first) };
      continue;
    }
    const direct = index.duration(concept, line.unit, period.start, period.end);
    if (direct) return { latest: toValue(direct.latest), asReported: toValue(direct.first) };
    if (frequency !== "quarterly" || line.additive === false) continue;

    // Year-to-date difference with the same concept: Q = YTD(Q) − YTD(previous quarter).
    const prevFp = PREVIOUS[period.fiscalPeriod];
    const fyStart = fiscalYearStart(period.fiscalYear);
    const prev = prevFp ? quarterOf(period.fiscalYear, prevFp) : undefined;
    if (!prevFp || !fyStart || !prev) continue;
    const ytd = index.duration(concept, line.unit, fyStart, period.end);
    const ytdPrev = index.duration(concept, line.unit, fyStart, prev.end);
    if (!ytd || !ytdPrev) continue;
    const how = `${YTD_LABEL[period.fiscalPeriod]} − ${YTD_LABEL[prevFp]}`;
    const derive = (a: FactRow, b: FactRow): LineValue => ({
      ...toValue(a, how),
      value: decimalSub(a.value, b.value),
    });
    return {
      latest: derive(ytd.latest, ytdPrev.latest),
      asReported: derive(ytd.first, ytdPrev.first),
    };
  }
  return null;
}

/**
 * Builds every statement for one registrant. Returns rows for both bases; a period with no
 * values for a statement produces no row for it.
 */
export function buildStatements(facts: readonly FactRow[]): StatementRow[] {
  const usd = facts.filter(
    (f) => f.unit === "USD" || f.unit === "USD/shares" || f.unit === "shares",
  );
  const index = new FactIndex(usd);
  const { annual, quarterly } = reportingPeriods(usd);
  const q1Start = new Map(
    quarterly.filter((q) => q.fiscalPeriod === "Q1").map((q) => [q.fiscalYear, q.start]),
  );
  const fyStart = new Map(annual.map((a) => [a.fiscalYear, a.start]));
  const fiscalYearStart = (fy: number) => q1Start.get(fy) ?? fyStart.get(fy) ?? null;
  const quarterOf = (fy: number, fp: FiscalPeriod) =>
    quarterly.find((q) => q.fiscalYear === fy && q.fiscalPeriod === fp);

  const rows: StatementRow[] = [];
  for (const def of STATEMENTS) {
    for (const [frequency, periods] of [
      ["annual", annual],
      ["quarterly", quarterly],
    ] as const) {
      for (const period of periods) {
        const latest: Record<string, LineValue> = {};
        const asReported: Record<string, LineValue> = {};
        for (const line of def.lines) {
          const v = lineValue(index, def, line, period, frequency, fiscalYearStart, quarterOf);
          if (!v) continue;
          latest[line.id] = v.latest;
          asReported[line.id] = v.asReported;
        }
        if (def.kind === "cashflow") {
          for (const items of [latest, asReported]) {
            const ocf = items.operatingCashFlow;
            const capex = items.capex;
            if (ocf && capex) {
              items.freeCashFlow = {
                ...ocf,
                value: decimalSub(ocf.value, capex.value),
                concept: "derived",
                derived: "cash from operations − capital expenditure",
              };
            }
          }
        }
        if (Object.keys(latest).length === 0) continue;
        const restated = Object.keys(latest).some((k) => latest[k]!.value !== asReported[k]?.value);
        const base = {
          statement: def.kind,
          frequency,
          fiscalYear: period.fiscalYear,
          fiscalPeriod: period.fiscalPeriod,
          periodStart: def.period === "instant" ? null : period.start,
          periodEnd: period.end,
          restated,
        };
        rows.push({ ...base, basis: "latest", lineItems: latest });
        rows.push({ ...base, basis: "as_reported", lineItems: asReported });
      }
    }
  }
  return rows;
}
