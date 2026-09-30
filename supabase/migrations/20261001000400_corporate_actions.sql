-- Corporate actions and the adjustment factors derived from them (spec §3.2, §3.7).

create table market.corporate_actions (
  action_id bigint generated always as identity primary key,
  security_id bigint not null references market.securities on delete cascade,
  type text not null check (type in (
    'split', 'cash_dividend', 'special_dividend', 'stock_dividend',
    'spin_off', 'symbol_change', 'merger'
  )),
  ex_date date not null,
  ratio numeric(24, 12),
  cash_amount numeric(20, 6),
  currency text check (currency ~ '^[A-Z]{3}$'),
  record_date date,
  pay_date date,
  details jsonb not null default '{}',
  source text not null references market.data_providers,
  ingested_at timestamptz not null default now(),
  constraint corporate_actions_key unique (security_id, type, ex_date, source),
  constraint corporate_actions_ratio check (
    type not in ('split', 'stock_dividend') or (ratio is not null and ratio > 0)
  ),
  constraint corporate_actions_cash check (
    type not in ('cash_dividend', 'special_dividend') or (cash_amount is not null and cash_amount > 0)
  )
);
comment on column market.corporate_actions.ratio is
  'New shares per old share: 4 for a 4:1 split, 0.1 for a 1:10 reverse split, 1.05 for a 5% stock dividend.';
create index corporate_actions_security_idx on market.corporate_actions (security_id, ex_date);
alter table market.corporate_actions enable row level security;

-- A sparse step function. Row (s, e) holds the cumulative factors of every action with
-- ex_date >= e. A raw bar dated d uses the row with the smallest ex_date > d; with no such row
-- both factors are 1.
create table market.adjustment_factors (
  security_id bigint not null references market.securities on delete cascade,
  ex_date date not null,
  split_factor double precision not null check (split_factor > 0),
  dividend_factor double precision not null check (dividend_factor > 0 and dividend_factor <= 1),
  computed_at timestamptz not null default now(),
  primary key (security_id, ex_date)
);
alter table market.adjustment_factors enable row level security;

create view market.prices_daily_adjusted
with (security_invoker = true)
as
select
  p.security_id,
  p.date,
  p.source,
  p.open::double precision * coalesce(f.split_factor, 1) * coalesce(f.dividend_factor, 1) as open,
  p.high::double precision * coalesce(f.split_factor, 1) * coalesce(f.dividend_factor, 1) as high,
  p.low::double precision * coalesce(f.split_factor, 1) * coalesce(f.dividend_factor, 1) as low,
  p.close::double precision * coalesce(f.split_factor, 1) * coalesce(f.dividend_factor, 1) as close,
  p.volume::double precision / coalesce(f.split_factor, 1) as volume,
  coalesce(f.split_factor, 1) as split_factor,
  coalesce(f.dividend_factor, 1) as dividend_factor
from market.prices_daily p
left join lateral (
  select af.split_factor, af.dividend_factor
  from market.adjustment_factors af
  where af.security_id = p.security_id and af.ex_date > p.date
  order by af.ex_date
  limit 1
) f on true;

comment on view market.prices_daily_adjusted is
  'Split- and dividend-adjusted bars computed on read from raw prices and adjustment_factors.';
