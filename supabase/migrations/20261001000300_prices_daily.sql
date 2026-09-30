-- Raw (unadjusted) daily bars, range-partitioned by year (spec §3.2).
--
-- Partitions are native, not pg_partman: yearly partitions are created ahead of time by
-- market.ensure_prices_daily_partition(), which the worker calls monthly. A DEFAULT partition
-- catches anything outside the created ranges, and the staleness monitor alerts if it holds any
-- rows (docs/DECISIONS.md ADR-004).
--
-- Raw prints are never overwritten with adjusted values; adjusted prices come from the
-- market.prices_daily_adjusted view. The CHECK constraints back up the ingest validator.

create table market.prices_daily (
  security_id bigint not null references market.securities,
  date date not null,
  source text not null references market.data_providers,
  open numeric(20, 6) not null,
  high numeric(20, 6) not null,
  low numeric(20, 6) not null,
  close numeric(20, 6) not null,
  volume bigint not null,
  vwap numeric(20, 6),
  ingestion_run_id bigint,
  ingested_at timestamptz not null default now(),
  primary key (security_id, date, source),
  constraint prices_daily_positive check (open > 0 and high > 0 and low > 0 and close > 0),
  constraint prices_daily_ohlc check (low <= least(open, close) and high >= greatest(open, close)),
  constraint prices_daily_volume check (volume >= 0),
  constraint prices_daily_vwap check (vwap is null or vwap > 0)
) partition by range (date);

comment on table market.prices_daily is
  'Raw daily bars. The primary key also serves (security_id, date DESC) lookups via backward scans.';

-- "All bars for a date" queries (freshness checks, screener snapshots).
create index prices_daily_date_idx on market.prices_daily (date);

alter table market.prices_daily enable row level security;

create table market.prices_daily_pre2000 partition of market.prices_daily
  for values from (minvalue) to ('2000-01-01');
alter table market.prices_daily_pre2000 enable row level security;

create table market.prices_daily_default partition of market.prices_daily default;
alter table market.prices_daily_default enable row level security;

create function market.ensure_prices_daily_partition(p_year integer)
returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  part text := format('prices_daily_y%s', p_year);
begin
  if p_year < 2000 or p_year > 2100 then
    raise exception 'year % is outside the supported range 2000-2100', p_year;
  end if;
  if to_regclass(format('market.%I', part)) is null then
    -- Fails if the DEFAULT partition already holds rows for this year; see RUNBOOK.md.
    execute format(
      'create table market.%I partition of market.prices_daily for values from (%L) to (%L)',
      part, make_date(p_year, 1, 1), make_date(p_year + 1, 1, 1)
    );
    execute format('alter table market.%I enable row level security', part);
  end if;
  return part;
end;
$$;

-- Functions are executable by PUBLIC by default, and a per-schema ALTER DEFAULT PRIVILEGES cannot
-- revoke that, so every function in market/ops revokes it explicitly.
revoke execute on function market.ensure_prices_daily_partition(integer) from public;

comment on function market.ensure_prices_daily_partition(integer) is
  'Idempotently creates the yearly prices_daily partition for p_year and enables RLS on it.';

select market.ensure_prices_daily_partition(y) from generate_series(2000, 2028) as y;
