import { sql, type Database } from "@market/db";
import type { FilingRecord, FundamentalFact } from "@market/market-data";

const CHUNK = 5000;

/** Facts are immutable per filing, so existing ones are left untouched. Returns rows inserted. */
export async function insertFacts(
  db: Database,
  facts: readonly FundamentalFact[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < facts.length; i += CHUNK) {
    const part = facts.slice(i, i + CHUNK);
    const col = <K extends keyof FundamentalFact>(k: K) => part.map((f) => f[k]);
    const result = await sql<{ n: string }>`
      with ins as (
        insert into market.fundamentals_facts
          (cik, taxonomy, concept, unit, value, period_start, period_end, fiscal_year, fiscal_period,
           form, filed_at, accession_no, frame, source)
        select t.*, 'sec_edgar' from unnest(
          ${col("cik")}::text[], ${col("taxonomy")}::text[], ${col("concept")}::text[], ${col("unit")}::text[],
          ${col("value").map(String)}::numeric[], ${col("period_start")}::date[], ${col("period_end")}::date[],
          ${col("fiscal_year")}::int[], ${col("fiscal_period")}::text[], ${col("form")}::text[],
          ${col("filed_at")}::date[], ${col("accession_no")}::text[], ${col("frame")}::text[]
        ) as t
        on conflict on constraint fundamentals_facts_key do nothing
        returning 1
      )
      select count(*) as n from ins
    `.execute(db);
    inserted += Number(result.rows[0]?.n ?? 0);
  }
  return inserted;
}

/** Inserts filings not seen before and returns them (filings are immutable once accepted). */
export async function insertFilings(
  db: Database,
  filings: readonly FilingRecord[],
): Promise<FilingRecord[]> {
  const inserted: FilingRecord[] = [];
  for (const f of filings) {
    const result = await db
      .insertInto("market.filings")
      .values({
        accession_no: f.accession_no,
        cik: f.cik,
        form_type: f.form_type,
        filed_at: f.filed_at,
        filing_date: f.filing_date,
        period: f.period,
        primary_document: f.primary_document,
        items: f.items,
        url: f.url,
        source: f.source,
      })
      .onConflict((oc) => oc.columns(["accession_no", "cik"]).doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) inserted.push(f);
  }
  return inserted;
}
