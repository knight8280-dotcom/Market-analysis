import { sql, type Database } from "@market/db";

/**
 * Read-only queries for the internal data-health page. They return metadata only (counts,
 * dates, statuses, error text); no price, volume or fundamental value is ever selected, so the
 * page cannot leak licensed data even to an authenticated operator.
 */

export interface DataHealth {
  generatedAt: string;
  hasSyntheticData: boolean;
  totals: {
    securities: number;
    activeSecurities: number;
    latestBarDate: string | null;
    securitiesWithLatestBar: number;
    defaultPartitionRows: number;
    correctionsLast7Days: number;
    fundamentalsFilings: number;
    macroSeries: number;
  };
  routes: {
    dataset: string;
    primary: string;
    fallback: string | null;
    active: string | null;
    failedOverAt: string | null;
    reason: string | null;
  }[];
  providers: {
    source: string;
    dataset: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
  }[];
  lastRuns: {
    dataset: string;
    lastSuccessAt: string | null;
    lastStatus: string;
    lastError: string | null;
    succeeded24h: number;
    failed24h: number;
  }[];
  openAlerts: {
    kind: string;
    dataset: string;
    source: string | null;
    severity: string;
    message: string;
    openedAt: string;
    lastSeenAt: string;
  }[];
  openIssues: { rule: string; severity: string; count: number }[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function getDataHealth(db: Database, now = new Date()): Promise<DataHealth> {
  const totals = await sql<{
    securities: string;
    active: string;
    latest: string | null;
    with_latest: string;
    default_rows: string;
    corrections: string;
    filings: string;
    macro: string;
  }>`
    with latest as (select max(date) as d from market.prices_daily)
    select
      (select count(*) from market.securities) as securities,
      (select count(*) from market.securities where is_active) as active,
      (select d::text from latest) as latest,
      (select count(distinct security_id) from market.prices_daily where date = (select d from latest)) as with_latest,
      (select count(*) from market.prices_daily_default) as default_rows,
      (select count(*) from ops.data_corrections where detected_at > ${now}::timestamptz - interval '7 days') as corrections,
      (select count(*) from market.filings) as filings,
      (select count(*) from market.macro_series) as macro
  `.execute(db);
  const t = totals.rows[0]!;

  const synthetic = await sql<{ yes: boolean }>`
    select exists (select 1 from market.provider_symbols where source = 'synthetic') as yes
  `.execute(db);

  const routes = await db
    .selectFrom("ops.dataset_routing")
    .selectAll()
    .orderBy("dataset")
    .execute();
  const providers = await db
    .selectFrom("ops.provider_health")
    .select([
      "source",
      "dataset",
      "last_success_at",
      "last_failure_at",
      "consecutive_failures",
      "last_error",
    ])
    .orderBy("dataset")
    .orderBy("source")
    .execute();

  const runs = await sql<{
    dataset: string;
    last_success_at: Date | null;
    last_status: string;
    last_error: string | null;
    succeeded_24h: string;
    failed_24h: string;
  }>`
    select dataset,
      max(finished_at) filter (where status = 'succeeded') as last_success_at,
      (array_agg(status order by started_at desc))[1] as last_status,
      (array_agg(error order by started_at desc))[1] as last_error,
      count(*) filter (where status = 'succeeded' and started_at > ${now}::timestamptz - interval '24 hours') as succeeded_24h,
      count(*) filter (where status = 'failed' and started_at > ${now}::timestamptz - interval '24 hours') as failed_24h
    from ops.data_ingestion_runs
    group by dataset
    order by dataset
  `.execute(db);

  const alerts = await db
    .selectFrom("ops.alerts")
    .select(["kind", "dataset", "source", "severity", "message", "opened_at", "last_seen_at"])
    .where("resolved_at", "is", null)
    .orderBy("opened_at", "desc")
    .execute();

  const issues = await sql<{ rule: string; severity: string; count: string }>`
    select rule, severity, count(*) as count from ops.data_quality_issues
    where status = 'open' group by rule, severity order by count(*) desc, rule
  `.execute(db);

  return {
    generatedAt: now.toISOString(),
    hasSyntheticData: synthetic.rows[0]?.yes === true,
    totals: {
      securities: Number(t.securities),
      activeSecurities: Number(t.active),
      latestBarDate: t.latest,
      securitiesWithLatestBar: Number(t.with_latest),
      defaultPartitionRows: Number(t.default_rows),
      correctionsLast7Days: Number(t.corrections),
      fundamentalsFilings: Number(t.filings),
      macroSeries: Number(t.macro),
    },
    routes: routes.map((r) => ({
      dataset: r.dataset,
      primary: r.primary_source,
      fallback: r.fallback_source,
      active: r.active_source,
      failedOverAt: iso(r.failed_over_at),
      reason: r.reason,
    })),
    providers: providers.map((p) => ({
      source: p.source,
      dataset: p.dataset,
      lastSuccessAt: iso(p.last_success_at),
      lastFailureAt: iso(p.last_failure_at),
      consecutiveFailures: p.consecutive_failures,
      lastError: p.last_error ? p.last_error.slice(0, 300) : null,
    })),
    lastRuns: runs.rows.map((r) => ({
      dataset: r.dataset,
      lastSuccessAt: iso(r.last_success_at),
      lastStatus: r.last_status,
      lastError: r.last_error ? r.last_error.slice(0, 300) : null,
      succeeded24h: Number(r.succeeded_24h),
      failed24h: Number(r.failed_24h),
    })),
    openAlerts: alerts.map((a) => ({
      kind: a.kind,
      dataset: a.dataset,
      source: a.source,
      severity: a.severity,
      message: a.message,
      openedAt: a.opened_at.toISOString(),
      lastSeenAt: a.last_seen_at.toISOString(),
    })),
    openIssues: issues.rows.map((i) => ({
      rule: i.rule,
      severity: i.severity,
      count: Number(i.count),
    })),
  };
}
