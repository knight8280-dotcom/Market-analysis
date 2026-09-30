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

/**
 * Inserts filings not seen before and returns them. Filings are immutable once accepted, but
 * our parsed metadata can change when a parser is fixed, so differing rows are updated in place
 * (without counting as new filings).
 */
export async function insertFilings(
  db: Database,
  filings: readonly FilingRecord[],
): Promise<FilingRecord[]> {
  const inserted: FilingRecord[] = [];
  for (const f of filings) {
    const result = await sql<{ inserted: boolean }>`
      insert into market.filings
        (accession_no, cik, form_type, filed_at, filing_date, period, primary_document, items, url, source)
      values (${f.accession_no}, ${f.cik}, ${f.form_type}, ${f.filed_at}, ${f.filing_date}, ${f.period},
              ${f.primary_document}, ${f.items}::text[], ${f.url}, ${f.source})
      on conflict (accession_no, cik) do update
        set form_type = excluded.form_type, filed_at = excluded.filed_at, filing_date = excluded.filing_date,
            period = excluded.period, primary_document = excluded.primary_document, items = excluded.items,
            url = excluded.url
        where (market.filings.form_type, market.filings.filed_at, market.filings.filing_date, market.filings.period,
               market.filings.primary_document, market.filings.items, market.filings.url)
          is distinct from (excluded.form_type, excluded.filed_at, excluded.filing_date, excluded.period,
                            excluded.primary_document, excluded.items, excluded.url)
      returning (xmax = 0) as inserted
    `.execute(db);
    if (result.rows[0]?.inserted === true) inserted.push(f);
  }
  return inserted;
}
