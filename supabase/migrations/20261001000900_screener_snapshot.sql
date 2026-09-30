-- Phase 1 step F: one row per listed security with everything the screener filters on, rebuilt
-- after each end-of-day load. Returns are fractions (0.05 = 5%) computed from split- and
-- dividend-adjusted closes (total return). Valuation ratios use trailing-twelve-month figures
-- from market.financial_statements and are NULL when an input is missing or earnings are not
-- positive: never estimated.
create table market.screener_snapshot (
  security_id bigint primary key references market.securities,
  ticker text not null,
  name text not null,
  asset_class text not null,
  exchange_mic text,
  sector text,
  industry text,
  source text not null references market.data_providers,
  as_of date not null,
  close numeric not null,
  change_1d double precision,
  return_1w double precision,
  return_1m double precision,
  return_3m double precision,
  return_6m double precision,
  return_ytd double precision,
  return_1y double precision,
  sma50 double precision,
  sma200 double precision,
  rsi14 double precision,
  high_52w double precision,
  low_52w double precision,
  avg_volume_30d double precision,
  shares_outstanding numeric,
  market_cap double precision,
  revenue_ttm numeric,
  net_income_ttm numeric,
  equity numeric,
  pe double precision,
  ps double precision,
  pb double precision,
  dividend_yield double precision,
  fundamentals_as_of date,
  refreshed_at timestamptz not null default now()
);

comment on table market.screener_snapshot is
  'Screener inputs per security: latest close, returns, technicals and TTM valuation.';

create index screener_snapshot_sector_idx on market.screener_snapshot (sector);
create index screener_snapshot_market_cap_idx on market.screener_snapshot (market_cap desc nulls last);

alter table market.screener_snapshot enable row level security;
