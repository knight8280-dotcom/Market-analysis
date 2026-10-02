-- Phase 2 step H3: equity short interest from FINRA's Query API (ADR-033). FINRA is a
-- self-regulatory organization, neither a vendor nor the government, so it gets its own kind.
alter table market.data_providers drop constraint data_providers_kind_check;
alter table market.data_providers add constraint data_providers_kind_check
  check (kind in ('synthetic', 'commercial', 'government', 'regulator'));
insert into market.data_providers (provider_id, display_name, kind) values
  ('finra', 'FINRA', 'regulator');

-- One row per security and settlement date (twice a month), as FINRA publishes it.
create table market.short_interest (
  security_id bigint not null references market.securities on delete cascade,
  settlement_date date not null,
  symbol text not null,
  issue_name text,
  market_class text,
  short_interest bigint not null check (short_interest >= 0),
  previous_short_interest bigint check (previous_short_interest >= 0),
  avg_daily_volume bigint check (avg_daily_volume >= 0),
  days_to_cover numeric check (days_to_cover >= 0),
  revised boolean not null default false,
  split_adjusted boolean not null default false,
  source text not null default 'finra' references market.data_providers,
  fetched_at timestamptz not null,
  primary key (security_id, settlement_date)
);
comment on column market.short_interest.days_to_cover is
  'FINRA''s days to cover (short interest / average daily volume); null when average volume is zero, where FINRA prints 999.99.';

alter table market.short_interest enable row level security;
