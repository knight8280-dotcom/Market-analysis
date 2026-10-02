import { sql, type Database } from "@market/db";
import type { InsiderFiling } from "@market/market-data";

/**
 * Stores one parsed Form 4 and its transaction lines in a single transaction. A re-parse (newer
 * parser version) replaces the lines; a document already stored at this version is left as is.
 */
export async function storeInsiderFiling(
  db: Database,
  filing: InsiderFiling,
  info: { url: string; filedAt: Date; parserVersion: number },
): Promise<{ stored: boolean }> {
  return db.transaction().execute(async (trx) => {
    const row = await sql<{ accession_no: string }>`
      insert into market.insider_filings
        (accession_no, issuer_cik, issuer_name, issuer_symbol, form_type, filed_at, period_of_report,
         original_filing_date, owners, aff_10b5_1, no_longer_subject_to_section16, remarks, footnotes,
         url, schema_version, source, fetched_at, parser_version)
      values (${filing.accession_no}, ${filing.issuer_cik}, ${filing.issuer_name}, ${filing.issuer_symbol},
              ${filing.form_type}, ${info.filedAt}, ${filing.period_of_report}, ${filing.original_filing_date},
              ${JSON.stringify(filing.owners)}::jsonb, ${filing.aff_10b5_1},
              ${filing.no_longer_subject_to_section16}, ${filing.remarks},
              ${JSON.stringify(filing.footnotes)}::jsonb, ${info.url}, ${filing.schema_version},
              ${filing.source}, ${filing.fetched_at}, ${info.parserVersion})
      on conflict (accession_no) do update set
        issuer_cik = excluded.issuer_cik, issuer_name = excluded.issuer_name,
        issuer_symbol = excluded.issuer_symbol, form_type = excluded.form_type,
        filed_at = excluded.filed_at, period_of_report = excluded.period_of_report,
        original_filing_date = excluded.original_filing_date, owners = excluded.owners,
        aff_10b5_1 = excluded.aff_10b5_1,
        no_longer_subject_to_section16 = excluded.no_longer_subject_to_section16,
        remarks = excluded.remarks, footnotes = excluded.footnotes, url = excluded.url,
        schema_version = excluded.schema_version, fetched_at = excluded.fetched_at,
        parser_version = excluded.parser_version
      where market.insider_filings.parser_version < excluded.parser_version
      returning accession_no
    `.execute(trx);
    if (row.rows.length === 0) return { stored: false };

    await trx
      .deleteFrom("market.insider_transactions")
      .where("accession_no", "=", filing.accession_no)
      .execute();
    if (filing.transactions.length > 0) {
      await trx
        .insertInto("market.insider_transactions")
        .values(
          filing.transactions.map((t) => ({
            accession_no: filing.accession_no,
            line: t.line,
            derivative: t.derivative,
            security_title: t.security_title,
            transaction_date: t.transaction_date,
            deemed_execution_date: t.deemed_execution_date,
            code: t.code,
            equity_swap: t.equity_swap,
            shares: t.shares === null ? null : String(t.shares),
            price: t.price === null ? null : String(t.price),
            acquired_disposed: t.acquired_disposed,
            shares_after: t.shares_after === null ? null : String(t.shares_after),
            ownership: t.ownership,
            ownership_nature: t.ownership_nature,
            conversion_price: t.conversion_price === null ? null : String(t.conversion_price),
            exercise_date: t.exercise_date,
            expiration_date: t.expiration_date,
            underlying_title: t.underlying_title,
            underlying_shares: t.underlying_shares === null ? null : String(t.underlying_shares),
            footnote_ids: t.footnote_ids,
          })),
        )
        .execute();
    }
    await trx
      .deleteFrom("market.insider_filing_errors")
      .where("accession_no", "=", filing.accession_no)
      .execute();
    return { stored: true };
  });
}

/** Remembers a filing that could not be read, so sweeps skip it until the parser changes. */
export async function recordInsiderError(
  db: Database,
  e: { accession: string; cik: string; error: string; parserVersion: number; at: Date },
): Promise<void> {
  await db
    .insertInto("market.insider_filing_errors")
    .values({
      accession_no: e.accession,
      cik: e.cik,
      error: e.error.slice(0, 2000),
      parser_version: e.parserVersion,
      failed_at: e.at,
    })
    .onConflict((oc) =>
      oc.column("accession_no").doUpdateSet({
        error: e.error.slice(0, 2000),
        parser_version: e.parserVersion,
        failed_at: e.at,
      }),
    )
    .execute();
}

export interface PendingInsiderFiling {
  accession_no: string;
  cik: string;
}

/**
 * Stored Form 4 and 4/A filings not yet read at this parser version (nor refused by it), filed
 * since `since`, newest first. A filing listed under several registrants (issuer and reporting
 * owners) appears once.
 */
export async function pendingInsiderFilings(
  db: Database,
  opts: { since: Date; parserVersion: number; ciks?: readonly string[]; limit?: number },
): Promise<PendingInsiderFiling[]> {
  const ciks = opts.ciks?.length ? opts.ciks : null;
  const rows = await sql<PendingInsiderFiling & { filed_at: Date }>`
    select distinct on (f.accession_no) f.accession_no, f.cik, f.filed_at
    from market.filings f
    where f.form_type in ('4', '4/A')
      and f.filed_at >= ${opts.since}
      and (${ciks}::text[] is null or f.cik = any(${ciks}::text[]))
      and not exists (
        select 1 from market.insider_filings i
        where i.accession_no = f.accession_no and i.parser_version >= ${opts.parserVersion})
      and not exists (
        select 1 from market.insider_filing_errors e
        where e.accession_no = f.accession_no and e.parser_version >= ${opts.parserVersion})
    order by f.accession_no, f.cik
  `.execute(db);
  return rows.rows
    .sort((a, b) => b.filed_at.getTime() - a.filed_at.getTime())
    .slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER)
    .map(({ accession_no, cik }) => ({ accession_no, cik }));
}
