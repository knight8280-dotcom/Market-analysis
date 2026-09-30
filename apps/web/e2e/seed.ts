import { createDb, createPool, sql } from "@market/db";
import { buildStatements, type FactRow } from "@market/market-data/statements";

/**
 * Seeds a made-up SEC registrant for the Financials tab: TEST_FIN, CIK 0000000042, with
 * synthetic facts (round numbers, not any real company's). Runs before the E2E suite; safe to
 * re-run. The same scenario as the statement builder's unit tests, scaled to millions.
 */
const CIK = "0000000042";
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
];

export async function seedFinancials(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl, { max: 2, applicationName: "e2e-seed" });
  const db = createDb(pool);
  try {
    await db.transaction().execute(async (trx) => {
      await sql`delete from market.fundamentals_facts where cik = ${CIK}`.execute(trx);
      await sql`delete from market.financial_statements where cik = ${CIK}`.execute(trx);
      for (const f of SEED_FACTS) {
        await sql`
          insert into market.fundamentals_facts (cik, taxonomy, concept, unit, value, period_start,
            period_end, fiscal_year, fiscal_period, form, filed_at, accession_no, source)
          values (${CIK}, ${f.taxonomy}, ${f.concept}, ${f.unit}, ${f.value}, ${f.period_start},
            ${f.period_end}, ${f.fiscal_year}, ${f.fiscal_period}, ${f.form}, ${f.filed_at},
            ${f.accession_no}, 'sec_edgar')
        `.execute(trx);
      }
      for (const r of buildStatements(SEED_FACTS)) {
        await sql`
          insert into market.financial_statements (cik, statement, frequency, basis, fiscal_year,
            fiscal_period, period_start, period_end, line_items, restated, source)
          values (${CIK}, ${r.statement}, ${r.frequency}, ${r.basis}, ${r.fiscalYear},
            ${r.fiscalPeriod}, ${r.periodStart}, ${r.periodEnd}, ${JSON.stringify(r.lineItems)},
            ${r.restated}, 'sec_edgar')
        `.execute(trx);
      }
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
      const existing = await sql<{ security_id: string }>`
        select security_id from market.securities where ticker = 'TEST_FIN'
      `.execute(trx);
      if (existing.rows.length === 0) {
        await sql`
          with s as (
            insert into market.securities (ticker, name, asset_class, cik, sector)
            values ('TEST_FIN', 'TEST_FIN Synthetic Financials Corp', 'equity', ${CIK}, 'Technology')
            returning security_id
          )
          insert into market.provider_symbols (security_id, source, source_symbol, valid_from)
          select security_id, 'synthetic', 'TEST_FIN', '2020-01-02' from s
        `.execute(trx);
      }
    });
  } finally {
    await pool.end();
  }
}
