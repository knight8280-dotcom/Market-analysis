import { sql, type Database } from "@market/db";
import type { DataSetFile, Form13fDataSet } from "@market/market-data/adapters/sec-datasets";
import type { CusipMatch } from "@market/ownership";

/** Our CUSIPs and the security each belongs to. */
export async function securityCusips(db: Database): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom("market.security_cusips")
    .select(["cusip", "security_id"])
    .execute();
  return new Map(rows.map((r) => [r.cusip, r.security_id]));
}

/** Stores matched CUSIPs, widening the dates each was seen. */
export async function upsertSecurityCusips(
  db: Database,
  matches: readonly CusipMatch[],
  at: Date,
): Promise<number> {
  for (const m of matches) {
    await db
      .insertInto("market.security_cusips")
      .values({
        cusip: m.cusip,
        security_id: m.security_id,
        symbol: m.symbol,
        description: m.description,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.column("cusip").doUpdateSet((eb) => ({
          security_id: eb.ref("excluded.security_id"),
          symbol: sql<string>`case when excluded.last_seen >= market.security_cusips.last_seen
                               then excluded.symbol else market.security_cusips.symbol end`,
          description: sql<string>`case when excluded.last_seen >= market.security_cusips.last_seen
                               then excluded.description else market.security_cusips.description end`,
          first_seen: sql<string>`least(market.security_cusips.first_seen, excluded.first_seen)`,
          last_seen: sql<string>`greatest(market.security_cusips.last_seen, excluded.last_seen)`,
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
  }
  return matches.length;
}

/**
 * Rebuilds the positions of the given filers and periods from every stored filing: the latest
 * holdings report or restatement (by filing date, then accession number), plus the NEW
 * HOLDINGS amendments filed after it. Independent of the order data sets were read in.
 */
async function rebuildPositions(
  trx: Database,
  pairs: readonly { filer_cik: string; report_period: string }[],
): Promise<number> {
  if (pairs.length === 0) return 0;
  const filers = pairs.map((p) => p.filer_cik);
  const periods = pairs.map((p) => p.report_period);
  await sql`
    delete from market.institutional_holdings h
    using unnest(${filers}::text[], ${periods}::date[]) as t(filer_cik, report_period)
    where h.filer_cik = t.filer_cik and h.report_period = t.report_period
  `.execute(trx);
  const inserted = await sql<{ n: string }>`
    with touched as (
      select distinct * from unnest(${filers}::text[], ${periods}::date[]) as t(filer_cik, report_period)
    ),
    base as (
      select distinct on (f.filer_cik, f.report_period)
        f.filer_cik, f.report_period, f.accession_no, f.filed_on, f.filer_name
      from market.form13f_filings f
      join touched t on t.filer_cik = f.filer_cik and t.report_period = f.report_period
      where f.submission_type in ('13F-HR', '13F-HR/A')
        and f.amendment_type is distinct from 'NEW HOLDINGS'
      order by f.filer_cik, f.report_period, f.filed_on desc, f.accession_no desc
    ),
    included as (
      select f.accession_no, f.filer_cik, f.report_period, f.filed_on, b.filer_name
      from market.form13f_filings f
      join base b on b.filer_cik = f.filer_cik and b.report_period = f.report_period
      where f.accession_no = b.accession_no
         or (f.submission_type = '13F-HR/A' and f.amendment_type = 'NEW HOLDINGS'
             and (f.filed_on, f.accession_no) > (b.filed_on, b.accession_no))
    ),
    ins as (
      insert into market.institutional_holdings
        (security_id, report_period, filer_cik, filer_name, shares, value_usd, filed_on, accession_nos)
      select h.security_id, i.report_period, i.filer_cik, min(i.filer_name), sum(h.shares),
             sum(h.value_usd), max(i.filed_on),
             array_agg(distinct i.accession_no order by i.accession_no)
      from included i
      join market.form13f_holdings h on h.accession_no = i.accession_no
      group by h.security_id, i.report_period, i.filer_cik
      returning 1
    )
    select count(*) as n from ins
  `.execute(trx);
  return Number(inserted.rows[0]?.n ?? 0);
}

/**
 * Stores one data set in a single transaction: its filings, their holdings in our securities,
 * and the rebuilt positions of every filer and period it touched.
 */
export async function storeForm13fDataSet(
  db: Database,
  file: DataSetFile,
  data: Form13fDataSet,
  cusips: ReadonlyMap<string, string>,
  at: Date,
): Promise<{ filings: number; holdings: number; positions: number }> {
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto("market.form13f_data_sets")
      .values({
        name: file.name,
        url: file.url,
        window_start: file.from,
        window_end: file.to,
        ingested_at: at,
        filings: data.filings.length,
        holdings: data.holdings.length,
        infotable_rows: String(data.infotableRows),
        row_count_mismatches: data.rowCountMismatches,
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet((eb) => ({
          url: eb.ref("excluded.url"),
          ingested_at: eb.ref("excluded.ingested_at"),
          filings: eb.ref("excluded.filings"),
          holdings: eb.ref("excluded.holdings"),
          infotable_rows: eb.ref("excluded.infotable_rows"),
          row_count_mismatches: eb.ref("excluded.row_count_mismatches"),
        })),
      )
      .execute();

    const CHUNK = 2000;
    for (let i = 0; i < data.filings.length; i += CHUNK) {
      await trx
        .insertInto("market.form13f_filings")
        .values(
          data.filings.slice(i, i + CHUNK).map((f) => ({
            ...f,
            table_value_total: f.table_value_total === null ? null : String(f.table_value_total),
            data_set: file.name,
          })),
        )
        .onConflict((oc) =>
          oc.column("accession_no").doUpdateSet((eb) => ({
            filer_cik: eb.ref("excluded.filer_cik"),
            filer_name: eb.ref("excluded.filer_name"),
            submission_type: eb.ref("excluded.submission_type"),
            report_type: eb.ref("excluded.report_type"),
            report_period: eb.ref("excluded.report_period"),
            filed_on: eb.ref("excluded.filed_on"),
            amendment_type: eb.ref("excluded.amendment_type"),
            table_entry_total: eb.ref("excluded.table_entry_total"),
            table_value_total: eb.ref("excluded.table_value_total"),
            data_set: eb.ref("excluded.data_set"),
          })),
        )
        .execute();
    }

    const accessions = data.filings.map((f) => f.accession_no);
    for (let i = 0; i < accessions.length; i += CHUNK) {
      await trx
        .deleteFrom("market.form13f_holdings")
        .where("accession_no", "in", accessions.slice(i, i + CHUNK))
        .execute();
    }
    const rows = data.holdings.flatMap((h) => {
      const security_id = cusips.get(h.cusip);
      return security_id
        ? [
            {
              accession_no: h.accession_no,
              security_id,
              cusip: h.cusip,
              shares: String(h.shares),
              value_usd: String(h.value_usd),
              rows: h.rows,
            },
          ]
        : [];
    });
    for (let i = 0; i < rows.length; i += CHUNK) {
      await trx
        .insertInto("market.form13f_holdings")
        .values(rows.slice(i, i + CHUNK))
        .execute();
    }

    const pairs = new Map<string, { filer_cik: string; report_period: string }>();
    for (const f of data.filings) {
      pairs.set(`${f.filer_cik}|${f.report_period}`, {
        filer_cik: f.filer_cik,
        report_period: f.report_period,
      });
    }
    const positions = await rebuildPositions(trx, [...pairs.values()]);
    return { filings: data.filings.length, holdings: rows.length, positions };
  });
}

/** Drops filings and positions for quarters before the retention window. */
export async function pruneForm13f(db: Database, fromPeriod: string): Promise<number> {
  await db
    .deleteFrom("market.institutional_holdings")
    .where("report_period", "<", fromPeriod)
    .execute();
  const result = await db
    .deleteFrom("market.form13f_filings")
    .where("report_period", "<", fromPeriod)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
