import { sql, type Database } from "@market/db";
import {
  STATEMENT_CONCEPTS,
  type FactRow,
  type StatementRow,
} from "@market/market-data/statements";

/** The facts the statement builder uses for one registrant (only the mapped concepts). */
export async function statementFacts(db: Database, cik: string): Promise<FactRow[]> {
  const pairs = STATEMENT_CONCEPTS.map((c) => c.split(":") as [string, string]);
  const rows = await sql<FactRow>`
    select taxonomy, concept, unit, value::text as value, period_start, period_end,
      fiscal_year, fiscal_period, form, filed_at, accession_no
    from market.fundamentals_facts
    where cik = ${cik}
      and (taxonomy, concept) in (${sql.join(pairs.map(([t, c]) => sql`(${t}, ${c})`))})
  `.execute(db);
  return rows.rows;
}

/** Replaces every statement row for a registrant in one transaction (idempotent). */
export async function replaceStatements(
  db: Database,
  cik: string,
  rows: readonly StatementRow[],
  source: string,
  at: Date,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom("market.financial_statements").where("cik", "=", cik).execute();
    for (let i = 0; i < rows.length; i += 500) {
      await trx
        .insertInto("market.financial_statements")
        .values(
          rows.slice(i, i + 500).map((r) => ({
            cik,
            statement: r.statement,
            frequency: r.frequency,
            basis: r.basis,
            fiscal_year: r.fiscalYear,
            fiscal_period: r.fiscalPeriod,
            period_start: r.periodStart,
            period_end: r.periodEnd,
            line_items: JSON.stringify(r.lineItems),
            restated: r.restated,
            source,
            built_at: at,
          })),
        )
        .execute();
    }
    return rows.length;
  });
}
