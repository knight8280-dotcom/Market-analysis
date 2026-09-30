-- Phase 1 step H: earnings (Finnhub, personal key) and economic release dates (FRED). Past
-- earnings dates without Finnhub come from 8-K Item 2.02 filings in market.filings instead.
create table market.earnings_events (
  security_id bigint not null references market.securities,
  source text not null references market.data_providers,
  report_date date not null,
  hour text check (hour in ('bmo', 'amc', 'dmh')),
  fiscal_year integer,
  fiscal_quarter integer check (fiscal_quarter between 1 and 4),
  eps_estimate numeric,
  eps_actual numeric,
  revenue_estimate numeric,
  revenue_actual numeric,
  fetched_at timestamptz not null,
  primary key (security_id, source, report_date)
);
create index earnings_events_date_idx on market.earnings_events (report_date);
comment on column market.earnings_events.hour is
  'bmo: before the open; amc: after the close; dmh: during market hours.';

create table market.economic_releases (
  source text not null references market.data_providers,
  release_id integer not null,
  name text not null,
  release_date date not null,
  fetched_at timestamptz not null,
  primary key (source, release_id, release_date)
);
create index economic_releases_date_idx on market.economic_releases (release_date);

alter table market.earnings_events enable row level security;
alter table market.economic_releases enable row level security;
