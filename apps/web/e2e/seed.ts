import { addDays, tradingDaysBetween } from "@market/calendar";
import { createDb, createPool, sql, type Database } from "@market/db";
import { buildStatements, type FactRow } from "@market/market-data/statements";

/**
 * Seeds made-up SEC registrants: TEST_FIN, CIK 0000000042, for the Financials and Valuation
 * tabs, and TEST_PEER, CIK 0000000043, its peer by industry code. Synthetic facts (round
 * numbers, not any real company's) and synthetic closes for three years up to the latest stored
 * session. Runs before the E2E suite; safe to re-run. TEST_FIN is the statement builder's unit
 * test scenario, scaled to millions.
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
    });
  } finally {
    await pool.end();
  }
}
