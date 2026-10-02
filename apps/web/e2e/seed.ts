import { addDays, tradingDaysBetween } from "@market/calendar";
import { createDb, createPool, sql, type Database } from "@market/db";
import { buildStatements, type FactRow } from "@market/market-data/statements";

/**
 * Seeds made-up SEC registrants: TEST_FIN, CIK 0000000042, for the Financials, Valuation and
 * Ownership tabs, and TEST_PEER, CIK 0000000043, its peer by industry code. Synthetic facts
 * (round numbers, not any real company's), synthetic closes for three years up to the latest
 * stored session, and made-up Form 4, 13F, short-interest and news rows. Runs before the E2E suite;
 * safe to re-run. TEST_FIN is the statement builder's unit test scenario, scaled to millions.
 */
const CIK = "0000000042";
const PRETAX =
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest";
const DILUTED = "WeightedAverageNumberOfDilutedSharesOutstanding";
const M = (millions: number) => String(millions * 1_000_000);

function fact(
  accession: string,
  filed: string,
  form: string,
  fy: number,
  fp: string,
  concept: string,
  value: string,
  start: string | null,
  end: string,
  unit = "USD",
): FactRow {
  return {
    taxonomy: "us-gaap",
    concept,
    unit,
    value,
    period_start: start,
    period_end: end,
    fiscal_year: fy,
    fiscal_period: fp,
    form,
    filed_at: filed,
    accession_no: accession,
  };
}

const K24 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-25-000001", "2025-02-10", "10-K", 2024, "FY", c, v, s, e, u);
const Q = (n: 1 | 2 | 3) => (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact(
    `0000000042-25-0000${n}0`,
    ["2025-05-01", "2025-08-01", "2025-11-01"][n - 1]!,
    "10-Q",
    2025,
    `Q${n}`,
    c,
    v,
    s,
    e,
    u,
  );
const K25 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000042-26-000001", "2026-02-10", "10-K", 2025, "FY", c, v, s, e, u);

export const SEED_FACTS: FactRow[] = [
  K24("Revenues", M(1000), "2024-01-01", "2024-12-31"),
  K24("NetIncomeLoss", M(100), "2024-01-01", "2024-12-31"),
  K24("EarningsPerShareDiluted", "1.00", "2024-01-01", "2024-12-31", "USD/shares"),
  K24("Assets", M(5000), null, "2024-12-31"),
  K24("NetCashProvidedByUsedInOperatingActivities", M(300), "2024-01-01", "2024-12-31"),
  K24("PaymentsToAcquirePropertyPlantAndEquipment", M(120), "2024-01-01", "2024-12-31"),
  Q(1)("Revenues", M(280), "2025-01-01", "2025-03-31"),
  Q(2)("Revenues", M(290), "2025-04-01", "2025-06-30"),
  Q(2)("Revenues", M(570), "2025-01-01", "2025-06-30"),
  Q(3)("Revenues", M(300), "2025-07-01", "2025-09-30"),
  Q(3)("Revenues", M(870), "2025-01-01", "2025-09-30"),
  K25("Revenues", M(1200), "2025-01-01", "2025-12-31"),
  K25("Revenues", M(1010), "2024-01-01", "2024-12-31"), // restates FY2024
  K25("NetIncomeLoss", M(130), "2025-01-01", "2025-12-31"),
  K25("Assets", M(5600), null, "2025-12-31"),
  // Valuation inputs (Phase 2 step D2).
  K24("OperatingIncomeLoss", M(150), "2024-01-01", "2024-12-31"),
  K25("OperatingIncomeLoss", M(180), "2025-01-01", "2025-12-31"),
  K24(PRETAX, M(130), "2024-01-01", "2024-12-31"),
  K25(PRETAX, M(165), "2025-01-01", "2025-12-31"),
  K24("IncomeTaxExpenseBenefit", M(27), "2024-01-01", "2024-12-31"),
  K25("IncomeTaxExpenseBenefit", M(35), "2025-01-01", "2025-12-31"),
  K24("DepreciationDepletionAndAmortization", M(40), "2024-01-01", "2024-12-31"),
  K25("DepreciationDepletionAndAmortization", M(48), "2025-01-01", "2025-12-31"),
  K25("PaymentsToAcquirePropertyPlantAndEquipment", M(140), "2025-01-01", "2025-12-31"),
  K25("NetCashProvidedByUsedInOperatingActivities", M(350), "2025-01-01", "2025-12-31"),
  K24("LongTermDebtNoncurrent", M(400), null, "2024-12-31"),
  K25("LongTermDebtNoncurrent", M(360), null, "2025-12-31"),
  K24("CashAndCashEquivalentsAtCarryingValue", M(250), null, "2024-12-31"),
  K25("CashAndCashEquivalentsAtCarryingValue", M(300), null, "2025-12-31"),
  K24(DILUTED, M(50), "2024-01-01", "2024-12-31", "shares"),
  K25(DILUTED, M(51), "2025-01-01", "2025-12-31", "shares"),
];

const PEER_CIK = "0000000043";
const PEER24 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000043-25-000001", "2025-02-20", "10-K", 2024, "FY", c, v, s, e, u);
const PEER25 = (c: string, v: string, s: string | null, e: string, u?: string) =>
  fact("0000000043-26-000001", "2026-02-20", "10-K", 2025, "FY", c, v, s, e, u);
const year = (fy: 2024 | 2025) => (fy === 2024 ? PEER24 : PEER25);
const span = (fy: number) => [`${fy}-01-01`, `${fy}-12-31`] as const;

export const PEER_FACTS: FactRow[] = ([2024, 2025] as const).flatMap((fy) => {
  const [start, end] = span(fy);
  const k = year(fy);
  const g = fy === 2024 ? 1 : 1.15;
  return [
    k("Revenues", M(2000 * g), start, end),
    k("NetIncomeLoss", M(150 * g), start, end),
    k("OperatingIncomeLoss", M(260 * g), start, end),
    k(PRETAX, M(190 * g), start, end),
    k("IncomeTaxExpenseBenefit", M(40 * g), start, end),
    k("DepreciationDepletionAndAmortization", M(70 * g), start, end),
    k("LongTermDebtNoncurrent", M(fy === 2024 ? 900 : 850), null, end),
    k("CashAndCashEquivalentsAtCarryingValue", M(fy === 2024 ? 300 : 350), null, end),
    k(DILUTED, M(fy === 2024 ? 120 : 121), start, end, "shares"),
  ];
});

/** A transaction is a Kysely instance for these helpers. */
type Trx = Database;

async function seedCompany(trx: Trx, cik: string, facts: readonly FactRow[]) {
  await sql`delete from market.fundamentals_facts where cik = ${cik}`.execute(trx);
  await sql`delete from market.financial_statements where cik = ${cik}`.execute(trx);
  for (const f of facts) {
    await sql`
      insert into market.fundamentals_facts (cik, taxonomy, concept, unit, value, period_start,
        period_end, fiscal_year, fiscal_period, form, filed_at, accession_no, source)
      values (${cik}, ${f.taxonomy}, ${f.concept}, ${f.unit}, ${f.value}, ${f.period_start},
        ${f.period_end}, ${f.fiscal_year}, ${f.fiscal_period}, ${f.form}, ${f.filed_at},
        ${f.accession_no}, 'sec_edgar')
    `.execute(trx);
  }
  for (const r of buildStatements(facts)) {
    await sql`
      insert into market.financial_statements (cik, statement, frequency, basis, fiscal_year,
        fiscal_period, period_start, period_end, line_items, restated, source)
      values (${cik}, ${r.statement}, ${r.frequency}, ${r.basis}, ${r.fiscalYear},
        ${r.fiscalPeriod}, ${r.periodStart}, ${r.periodEnd}, ${JSON.stringify(r.lineItems)},
        ${r.restated}, 'sec_edgar')
    `.execute(trx);
  }
}

/**
 * Synthetic closes for three years up to the latest stored session, so the Valuation tab has
 * prices and history. Deterministic, clearly made up (source "synthetic").
 */
async function seedPrices(trx: Trx, ticker: string, base: number) {
  const latest = await sql<{ d: string | null }>`
    select max(p.date)::text as d from market.prices_daily p
    join market.securities s using (security_id)
    where p.source = 'synthetic' and s.ticker not in ('TEST_FIN', 'TEST_PEER')
  `.execute(trx);
  const end = latest.rows[0]?.d;
  if (!end) return;
  const sessions = tradingDaysBetween(addDays(end, -3 * 365), end);
  for (const y of new Set(sessions.map((d) => Number(d.slice(0, 4))))) {
    await sql`select market.ensure_prices_daily_partition(${y}::int)`.execute(trx);
  }
  await sql`
    delete from market.prices_daily
    where security_id = (select security_id from market.securities where ticker = ${ticker})
  `.execute(trx);
  const rows = sessions.map((date, i) => {
    const close = Math.round(base * (1 + 0.15 * Math.sin(i / 30)) * (1 + i * 0.0003) * 100) / 100;
    return { date, close };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sql`
      insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
      select s.security_id, v.date::date, 'synthetic', v.close, v.close * 1.01, v.close * 0.99,
        v.close, 1000000
      from market.securities s,
        jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(date text, close numeric)
      where s.ticker = ${ticker}
    `.execute(trx);
  }
}

async function ensureSecurity(
  trx: Trx,
  ticker: string,
  name: string,
  cik: string,
  sic: string,
  industry: string,
) {
  const existing = await sql<{ security_id: string }>`
    select security_id from market.securities where ticker = ${ticker}
  `.execute(trx);
  if (existing.rows.length === 0) {
    await sql`
      with s as (
        insert into market.securities (ticker, name, asset_class, cik, sector, sic_code, industry)
        values (${ticker}, ${name}, 'equity', ${cik}, 'Technology', ${sic}, ${industry})
        returning security_id
      )
      insert into market.provider_symbols (security_id, source, source_symbol, valid_from)
      select security_id, 'synthetic', ${ticker}, '2020-01-02' from s
    `.execute(trx);
  } else {
    await sql`
      update market.securities set sic_code = ${sic}, industry = ${industry}, cik = ${cik}
      where ticker = ${ticker}
    `.execute(trx);
  }
}

export async function seedFinancials(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl, { max: 2, applicationName: "e2e-seed" });
  const db = createDb(pool);
  try {
    await db.transaction().execute(async (trx) => {
      await seedCompany(trx, CIK, SEED_FACTS);
      await seedCompany(trx, PEER_CIK, PEER_FACTS);
      // A made-up 8-K Item 2.02 ("Results of Operations") three days ago, for the earnings
      // calendar and chart markers.
      const reported = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
      await sql`delete from market.filings where cik = ${CIK}`.execute(trx);
      await sql`
        insert into market.filings (accession_no, cik, form_type, filed_at, filing_date, items,
          url, source)
        values ('0000000042-26-000100', ${CIK}, '8-K', ${`${reported}T21:05:00Z`}, ${reported},
          '{2.02,9.01}', 'https://example.invalid/test-fin/8-k', 'sec_edgar')
      `.execute(trx);
      await ensureSecurity(
        trx,
        "TEST_FIN",
        "TEST_FIN Synthetic Financials Corp",
        CIK,
        "7372",
        "Prepackaged Software",
      );
      await ensureSecurity(
        trx,
        "TEST_PEER",
        "TEST_PEER Synthetic Software Corp",
        PEER_CIK,
        "7372",
        "Prepackaged Software",
      );
      await seedPrices(trx, "TEST_FIN", 40);
      await seedPrices(trx, "TEST_PEER", 30);
      await seedOwnership(trx);
      await seedNews(trx);
    });
  } finally {
    await pool.end();
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const owner = (cik: string, name: string, role: Record<string, unknown>) => ({
  cik,
  name,
  is_director: false,
  is_officer: false,
  officer_title: null,
  is_ten_percent_owner: false,
  is_other: false,
  other_text: null,
  ...role,
});
const ONE = owner("0000000901", "TEST INSIDER ONE", { is_director: true });
const TWO = owner("0000000902", "TEST INSIDER TWO", {
  is_officer: true,
  officer_title: "Chief Executive Officer",
});
const THREE = owner("0000000903", "TEST INSIDER THREE", { is_ten_percent_owner: true });
const AVERAGE = { F1: "The price is a weighted average of purchases from $41.25 to $41.75." };

interface SeedLine {
  derivative?: boolean;
  title?: string;
  daysAgo: number;
  code: string;
  shares: number;
  price: number | null;
  ad: "A" | "D";
  after: number;
  indirect?: string;
  notes?: string[];
}

/**
 * Form 4s, relative to today: purchases by three insiders within three weeks, a sale under a
 * 10b5-1 plan and an amendment that repeats a purchase (left out of totals).
 */
const FORM4: {
  accession: string;
  form: "4" | "4/A";
  filedDaysAgo: number;
  owners: ReturnType<typeof owner>[];
  plan: boolean | null;
  footnotes?: Record<string, string>;
  original?: number;
  lines: SeedLine[];
}[] = [
  {
    accession: "0000000042-26-000201",
    form: "4",
    filedDaysAgo: 20,
    owners: [ONE],
    plan: false,
    lines: [
      { daysAgo: 21, code: "P", shares: 1000, price: 40, ad: "A", after: 5000 },
      {
        derivative: true,
        title: "Stock Option (right to buy)",
        daysAgo: 21,
        code: "A",
        shares: 5000,
        price: null,
        ad: "A",
        after: 5000,
      },
    ],
  },
  {
    accession: "0000000042-26-000202",
    form: "4",
    filedDaysAgo: 14,
    owners: [TWO],
    plan: false,
    footnotes: AVERAGE,
    lines: [
      { daysAgo: 15, code: "P", shares: 2000, price: 41.5, ad: "A", after: 12000, notes: ["F1"] },
    ],
  },
  {
    accession: "0000000042-26-000203",
    form: "4",
    filedDaysAgo: 9,
    owners: [THREE],
    plan: false,
    lines: [
      {
        daysAgo: 10,
        code: "P",
        shares: 500,
        price: 42,
        ad: "A",
        after: 80500,
        indirect: "By TEST Holdings LLC",
      },
    ],
  },
  {
    accession: "0000000042-26-000204",
    form: "4",
    filedDaysAgo: 4,
    owners: [TWO],
    plan: true,
    lines: [{ daysAgo: 5, code: "S", shares: 300, price: 43, ad: "D", after: 11700 }],
  },
  {
    accession: "0000000042-26-000205",
    form: "4/A",
    filedDaysAgo: 3,
    owners: [TWO],
    plan: false,
    footnotes: AVERAGE,
    original: 14,
    lines: [
      { daysAgo: 15, code: "P", shares: 2000, price: 41.5, ad: "A", after: 12000, notes: ["F1"] },
    ],
  },
];

/**
 * 13F: two quarters of made-up managers' positions in TEST_FIN. The data set names follow SEC's
 * pattern with windows SEC never uses (its sets run Dec-Feb, Mar-May, Jun-Aug and Sep-Nov), so
 * they cannot be mistaken for real ones.
 */
const DATA_SETS = [
  { name: "01apr2025-30jun2025_form13f.zip", start: "2025-04-01", end: "2025-06-30" },
  { name: "01jul2025-30sep2025_form13f.zip", start: "2025-07-01", end: "2025-09-30" },
] as const;
const FORM13F: {
  accession: string;
  cik: string;
  name: string;
  period: string;
  filed: string;
  set: 0 | 1;
  shares: number | null;
  value: number | null;
}[] = [
  {
    accession: "0000000911-25-000001",
    cik: "0000000911",
    name: "TEST Capital Management LP",
    period: "2025-03-31",
    filed: "2025-05-14",
    set: 0,
    shares: 100_000,
    value: 4_000_000,
  },
  {
    accession: "0000000912-25-000001",
    cik: "0000000912",
    name: "TEST Index Advisors LLC",
    period: "2025-03-31",
    filed: "2025-05-13",
    set: 0,
    shares: 250_000,
    value: 10_000_000,
  },
  {
    accession: "0000000914-25-000001",
    cik: "0000000914",
    name: "TEST Former Holder Inc",
    period: "2025-03-31",
    filed: "2025-05-12",
    set: 0,
    shares: 60_000,
    value: 2_400_000,
  },
  {
    accession: "0000000911-25-000002",
    cik: "0000000911",
    name: "TEST Capital Management LP",
    period: "2025-06-30",
    filed: "2025-08-14",
    set: 1,
    shares: 150_000,
    value: 6_300_000,
  },
  {
    accession: "0000000912-25-000002",
    cik: "0000000912",
    name: "TEST Index Advisors LLC",
    period: "2025-06-30",
    filed: "2025-08-13",
    set: 1,
    shares: 250_000,
    value: 10_500_000,
  },
  {
    accession: "0000000913-25-000001",
    cik: "0000000913",
    name: "TEST Growth Partners",
    period: "2025-06-30",
    filed: "2025-08-12",
    set: 1,
    shares: 40_000,
    value: 1_680_000,
  },
  // Files for the quarter without TEST_FIN: listed last quarter, not this one.
  {
    accession: "0000000914-25-000002",
    cik: "0000000914",
    name: "TEST Former Holder Inc",
    period: "2025-06-30",
    filed: "2025-08-12",
    set: 1,
    shares: null,
    value: null,
  },
];

/** Short interest: made-up figures in FINRA's shape (FINRA's own data is never committed). */
const SHORT_INTEREST = [
  { date: "2026-09-15", si: 1_200_000, prev: 1_000_000, adv: 400_000, dtc: "3", revised: false },
  { date: "2026-08-29", si: 1_000_000, prev: 950_000, adv: 500_000, dtc: "2", revised: true },
  { date: "2026-08-15", si: 950_000, prev: 900_000, adv: 0, dtc: null, revised: false },
];

async function seedOwnership(trx: Trx) {
  const fin = (
    await sql<{ security_id: string }>`
      select security_id from market.securities where ticker = 'TEST_FIN'
    `.execute(trx)
  ).rows[0]!.security_id;

  await sql`delete from market.insider_filings where issuer_cik = ${CIK}`.execute(trx);
  for (const f of FORM4) {
    const filedAt = `${daysAgo(f.filedDaysAgo)}T21:30:00Z`;
    await sql`
      insert into market.insider_filings (accession_no, issuer_cik, issuer_name, issuer_symbol,
        form_type, filed_at, period_of_report, original_filing_date, owners, aff_10b5_1,
        footnotes, url, source, fetched_at, parser_version)
      values (${f.accession}, ${CIK}, 'TEST_FIN Synthetic Financials Corp', 'TEST_FIN',
        ${f.form}, ${filedAt}, ${daysAgo(Math.max(...f.lines.map((l) => l.daysAgo)))},
        ${f.original === undefined ? null : daysAgo(f.original)}, ${JSON.stringify(f.owners)},
        ${f.plan}, ${JSON.stringify(f.footnotes ?? {})},
        ${`https://example.invalid/test-fin/form4/${f.accession}`}, 'sec_edgar', ${filedAt}, 1)
    `.execute(trx);
    for (const [i, l] of f.lines.entries()) {
      await sql`
        insert into market.insider_transactions (accession_no, line, derivative, security_title,
          transaction_date, code, shares, price, acquired_disposed, shares_after, ownership,
          ownership_nature, footnote_ids)
        values (${f.accession}, ${i + 1}, ${l.derivative ?? false},
          ${l.title ?? "Common Stock"}, ${daysAgo(l.daysAgo)}, ${l.code}, ${l.shares}, ${l.price},
          ${l.ad}, ${l.after}, ${l.indirect ? "I" : "D"}, ${l.indirect ?? null},
          ${l.notes ?? []})
      `.execute(trx);
    }
  }

  for (const d of DATA_SETS) {
    await sql`delete from market.form13f_data_sets where name = ${d.name}`.execute(trx);
  }
  await sql`delete from market.institutional_holdings where security_id = ${fin}`.execute(trx);
  await sql`delete from market.security_cusips where security_id = ${fin}`.execute(trx);
  await sql`
    insert into market.security_cusips (cusip, security_id, symbol, description, first_seen,
      last_seen)
    values ('TESTFIN01', ${fin}, 'TEST_FIN', 'TEST_FIN SYNTHETIC FINANCIALS', '2025-01-02',
      '2025-09-30')
  `.execute(trx);
  for (const [i, d] of DATA_SETS.entries()) {
    const filings = FORM13F.filter((f) => f.set === i);
    await sql`
      insert into market.form13f_data_sets (name, url, window_start, window_end, ingested_at,
        filings, holdings, infotable_rows)
      values (${d.name}, ${`https://example.invalid/test-13f/${d.name}`}, ${d.start}, ${d.end},
        now(), ${filings.length}, ${filings.filter((f) => f.shares !== null).length},
        ${filings.filter((f) => f.shares !== null).length})
    `.execute(trx);
  }
  for (const f of FORM13F) {
    await sql`
      insert into market.form13f_filings (accession_no, filer_cik, filer_name, submission_type,
        report_type, report_period, filed_on, table_entry_total, table_value_total, data_set)
      values (${f.accession}, ${f.cik}, ${f.name}, '13F-HR', '13F HOLDINGS REPORT', ${f.period},
        ${f.filed}, ${f.shares === null ? 0 : 1}, ${f.value ?? 0},
        ${DATA_SETS[f.set].name})
    `.execute(trx);
    if (f.shares === null) continue;
    await sql`
      insert into market.form13f_holdings (accession_no, security_id, cusip, shares, value_usd,
        rows)
      values (${f.accession}, ${fin}, 'TESTFIN01', ${f.shares}, ${f.value}, 1)
    `.execute(trx);
    await sql`
      insert into market.institutional_holdings (security_id, report_period, filer_cik,
        filer_name, shares, value_usd, filed_on, accession_nos)
      values (${fin}, ${f.period}, ${f.cik}, ${f.name}, ${f.shares}, ${f.value}, ${f.filed},
        ${[f.accession]})
    `.execute(trx);
  }

  await sql`delete from market.short_interest where security_id = ${fin}`.execute(trx);
  for (const r of SHORT_INTEREST) {
    await sql`
      insert into market.short_interest (security_id, settlement_date, symbol, issue_name,
        market_class, short_interest, previous_short_interest, avg_daily_volume, days_to_cover,
        revised, source, fetched_at)
      values (${fin}, ${r.date}, 'TEST_FIN', 'TEST_FIN Synthetic Financials Corp', 'NYSE',
        ${r.si}, ${r.prev}, ${r.adv}, ${r.dtc}, ${r.revised}, 'finra', now())
    `.execute(trx);
  }
}

/**
 * News for TEST_FIN, relative to today: a press release with a wire copy, a news story, an
 * exhibit without a headline, and one story older than the tab's 90 days. Made up; links go to
 * example.invalid.
 */
const NEWS: {
  key: string;
  source: "sec_edgar" | "finnhub";
  daysAgo: number;
  headline: string;
  described?: boolean;
  summary: string | null;
  publisher: string;
  url: string;
  copyOf?: string;
  /** A made-up model estimate, in the shape the sentiment job stores. */
  sentiment?: { label: "negative" | "neutral" | "positive"; score: string };
}[] = [
  {
    key: "press",
    source: "sec_edgar",
    daysAgo: 3,
    headline: "TEST_FIN Synthetic Financials Corp Reports Fourth Quarter Results",
    summary:
      "SPRINGFIELD, Ill. – TEST_FIN Synthetic Financials Corp (TEST: TEST_FIN) today reported made-up results for testing.",
    publisher: "TEST_FIN Synthetic Financials Corp",
    url: "https://example.invalid/test-fin/8-k/ex99-1.htm",
    sentiment: { label: "neutral", score: "0.10" },
  },
  {
    key: "wire",
    source: "finnhub",
    daysAgo: 3,
    headline: "TEST_FIN Synthetic Financials Corp Reports Fourth-Quarter Results",
    summary: "The same release, carried by a wire service.",
    publisher: "Example Wire",
    url: "https://wire.example.invalid/test-fin-results",
    copyOf: "press",
  },
  {
    key: "story",
    source: "finnhub",
    daysAgo: 1,
    headline: "TEST_FIN opens a made-up research center",
    summary: "A made-up story for testing the News tab.",
    publisher: "Example Daily",
    url: "https://news.example.invalid/test-fin-center",
    sentiment: { label: "positive", score: "0.40" },
  },
  {
    key: "deck",
    source: "sec_edgar",
    daysAgo: 10,
    headline:
      "TEST_FIN Synthetic Financials Corp filed Exhibit 99.1 with a Form 8-K: Regulation FD Disclosure",
    described: true,
    summary: null,
    publisher: "TEST_FIN Synthetic Financials Corp",
    url: "https://example.invalid/test-fin/8-k/deck.htm",
  },
  {
    key: "old",
    source: "finnhub",
    daysAgo: 120,
    headline: "An old TEST_FIN story outside the tab's window",
    summary: null,
    publisher: "Example Daily",
    url: "https://news.example.invalid/test-fin-old",
  },
];

async function seedNews(trx: Trx) {
  const fin = (
    await sql<{ security_id: string }>`
      select security_id from market.securities where ticker = 'TEST_FIN'
    `.execute(trx)
  ).rows[0]!.security_id;
  await sql`delete from market.news_articles where source_id like 'TEST_FIN-%'`.execute(trx);
  const ids = new Map<string, string>();
  for (const n of NEWS) {
    const at = new Date(Date.now() - n.daysAgo * 86_400_000);
    const row = await sql<{ article_id: string }>`
      insert into market.news_articles (source, source_id, url, url_key, headline, described,
        summary, publisher, category, published_at, fetched_at, license_tier, duplicate_of,
        sentiment_label, sentiment_score, sentiment_model, sentiment_version, sentiment_at)
      values (${n.source}, ${`TEST_FIN-${n.key}`}, ${n.url}, ${n.url.replace(/^https:\/\//, "")},
        ${n.headline}, ${n.described ?? false}, ${n.summary}, ${n.publisher},
        ${n.source === "sec_edgar" ? "press release" : "company"}, ${at}, ${at},
        ${n.source === "sec_edgar" ? "public_domain" : "personal_dev"},
        ${n.copyOf ? ids.get(n.copyOf)! : null}, ${n.sentiment?.label ?? null},
        ${n.sentiment?.score ?? null},
        ${n.sentiment ? "claude-haiku-4-5-20251001" : null},
        ${n.sentiment ? "news-sentiment-v1" : null}, ${n.sentiment ? at : null})
      returning article_id
    `.execute(trx);
    ids.set(n.key, row.rows[0]!.article_id);
    await sql`
      insert into market.news_tickers (article_id, security_id)
      values (${row.rows[0]!.article_id}, ${fin})
    `.execute(trx);
  }
}
