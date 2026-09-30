import { latestSessionDueBy } from "@market/calendar";
import { sql, type Database } from "@market/db";
import type { Dataset } from "@market/market-data";

/** Freshness SLOs (spec §3.7). */
export const FRESHNESS_SLOS = {
  /** EOD bars for a session must be loaded by 6:30 p.m. ET that day, for 98% of listed securities. */
  daily_bars: { dueBy: "18:30", minCoverage: 0.98 },
  /** Facts for a 10-K/10-Q must arrive within 24h of the filing (checked over the last 7 days). */
  fundamentals: {
    maxLagHours: 24,
    lookbackDays: 7,
    forms: ["10-K", "10-Q", "10-K/A", "10-Q/A", "20-F", "40-F"],
  },
  /** Each macro series is refreshed at least daily. */
  macro: { maxAgeHours: 26 },
} as const;

export interface FreshnessResult {
  dataset: Dataset;
  /** False when there is nothing to monitor yet (e.g. no securities loaded). */
  applicable: boolean;
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
}

export async function checkDailyBars(db: Database, now: Date): Promise<FreshnessResult> {
  const session = latestSessionDueBy(now, FRESHNESS_SLOS.daily_bars.dueBy);
  const date = session.date;
  const r = await sql<{ expected: string; present: string; latest: string | null }>`
    with expected as (
      select s.security_id from market.securities s
      where (s.listed_at is null or s.listed_at <= ${date}::date)
        and (s.delisted_at is null or s.delisted_at > ${date}::date)
        and exists (select 1 from market.provider_symbols ps where ps.security_id = s.security_id)
    )
    select
      (select count(*) from expected) as expected,
      (select count(distinct p.security_id) from market.prices_daily p
        where p.date = ${date}::date and p.security_id in (select security_id from expected)) as present,
      (select max(date)::text from market.prices_daily) as latest
  `.execute(db);
  const expected = Number(r.rows[0]?.expected ?? 0);
  const present = Number(r.rows[0]?.present ?? 0);
  const coverage = expected === 0 ? 1 : present / expected;
  const ok = coverage >= FRESHNESS_SLOS.daily_bars.minCoverage;
  return {
    dataset: "daily_bars",
    applicable: expected > 0,
    ok,
    message: ok
      ? `EOD bars for ${date}: ${present}/${expected} securities`
      : `EOD bars for ${date} missing: ${present}/${expected} securities loaded (${(coverage * 100).toFixed(1)}%), due 18:30 ET`,
    details: {
      session: date,
      expected,
      present,
      coverage,
      latest_bar_date: r.rows[0]?.latest ?? null,
    },
  };
}

export async function checkFundamentals(db: Database, now: Date): Promise<FreshnessResult> {
  const slo = FRESHNESS_SLOS.fundamentals;
  const lagCutoff = new Date(now.getTime() - slo.maxLagHours * 3600_000);
  const lookback = new Date(now.getTime() - slo.lookbackDays * 86400_000);
  const r = await sql<{ accession_no: string; cik: string; form_type: string }>`
    select f.accession_no, f.cik, f.form_type from market.filings f
    where f.form_type in (${sql.join([...slo.forms])})
      and f.filed_at >= ${lookback} and f.filed_at < ${lagCutoff}
      and not exists (select 1 from market.fundamentals_facts x where x.accession_no = f.accession_no)
    order by f.filed_at
    limit 50
  `.execute(db);
  const any = await sql<{ n: string }>`select count(*) as n from market.filings`.execute(db);
  const missing = r.rows;
  return {
    dataset: "fundamentals",
    applicable: Number(any.rows[0]?.n ?? 0) > 0,
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? "Fundamentals up to date with filings"
        : `${missing.length} filing(s) older than ${slo.maxLagHours}h have no XBRL facts yet`,
    details: { missing },
  };
}

export async function checkMacro(db: Database, now: Date): Promise<FreshnessResult> {
  const cutoff = new Date(now.getTime() - FRESHNESS_SLOS.macro.maxAgeHours * 3600_000);
  const rows = await db
    .selectFrom("market.macro_series")
    .select(["series_id", "ingested_at"])
    .execute();
  const stale = rows.filter((r) => r.ingested_at < cutoff).map((r) => r.series_id);
  return {
    dataset: "macro",
    applicable: rows.length > 0,
    ok: stale.length === 0,
    message:
      stale.length === 0
        ? "Macro series refreshed"
        : `Macro series not refreshed in ${FRESHNESS_SLOS.macro.maxAgeHours}h: ${stale.join(", ")}`,
    details: { stale },
  };
}
