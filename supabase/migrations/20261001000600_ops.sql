-- Operational tables: ingestion runs, corrections, data quality, provider health, routing and
-- alerts (spec §3.7, §7 "Observability of data feeds").

create table ops.data_ingestion_runs (
  run_id bigint generated always as identity primary key,
  job_name text not null,
  job_id text,
  dataset text not null,
  source text references market.data_providers,
  params jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_fetched integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_rejected integer not null default 0,
  rows_flagged integer not null default 0,
  http_status_counts jsonb not null default '{}',
  error text
);
create index data_ingestion_runs_dataset_idx on ops.data_ingestion_runs (dataset, started_at desc);
alter table ops.data_ingestion_runs enable row level security;

-- A vendor changed a bar we had already stored (late or corrected print).
create table ops.data_corrections (
  correction_id bigint generated always as identity primary key,
  security_id bigint not null references market.securities on delete cascade,
  date date not null,
  source text not null references market.data_providers,
  old_values jsonb not null,
  new_values jsonb not null,
  run_id bigint references ops.data_ingestion_runs on delete set null,
  detected_at timestamptz not null default now()
);
create index data_corrections_security_idx on ops.data_corrections (security_id, date);
alter table ops.data_corrections enable row level security;

create table ops.data_quality_issues (
  issue_id bigint generated always as identity primary key,
  run_id bigint references ops.data_ingestion_runs on delete set null,
  dataset text not null,
  source text references market.data_providers,
  security_id bigint references market.securities on delete cascade,
  date date,
  rule text not null,
  severity text not null check (severity in ('info', 'warning', 'error')),
  action text not null check (action in ('rejected', 'flagged', 'skipped')),
  message text not null,
  payload jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- Re-running an ingest must not pile up duplicate open issues for the same bar and rule.
create unique index data_quality_issues_open_key
  on ops.data_quality_issues (dataset, source, security_id, date, rule) nulls not distinct
  where status = 'open';
create index data_quality_issues_status_idx on ops.data_quality_issues (status, created_at desc);
alter table ops.data_quality_issues enable row level security;

create table ops.provider_health (
  source text not null references market.data_providers,
  dataset text not null,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  -- Counts successful requests and failback probes since the last failure.
  consecutive_successes integer not null default 0,
  last_latency_ms integer,
  requests_total bigint not null default 0,
  failures_total bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (source, dataset)
);
alter table ops.provider_health enable row level security;

-- Which provider currently serves each dataset. active_source is NULL when no provider is
-- available; readers then serve last-good data with a staleness banner.
create table ops.dataset_routing (
  dataset text primary key,
  primary_source text not null references market.data_providers,
  fallback_source text references market.data_providers,
  active_source text references market.data_providers,
  failed_over_at timestamptz,
  reason text,
  updated_at timestamptz not null default now(),
  constraint dataset_routing_distinct check (fallback_source is null or fallback_source <> primary_source)
);
alter table ops.dataset_routing enable row level security;

create table ops.alerts (
  alert_id bigint generated always as identity primary key,
  kind text not null check (kind in (
    'staleness', 'failover', 'failback', 'data_quality', 'partition', 'rate_limit'
  )),
  dataset text not null,
  source text references market.data_providers,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  message text not null,
  details jsonb not null default '{}',
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- At most one open alert per (kind, dataset, source).
create unique index alerts_one_open
  on ops.alerts (kind, dataset, source) nulls not distinct
  where resolved_at is null;
create index alerts_opened_idx on ops.alerts (opened_at desc);
alter table ops.alerts enable row level security;
