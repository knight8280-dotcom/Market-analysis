-- Phase 1 step E: financial statements built from XBRL facts (market.fundamentals_facts).
-- One row per registrant, statement, frequency, basis and period. "latest" takes each value from
-- the most recent filing that reported it (restatements included); "as_reported" from the
-- earliest. Every value in line_items carries its concept, unit, accession and filing date, so
-- any number on screen can be traced to the filing it came from.
create table market.financial_statements (
  cik text not null check (cik ~ '^[0-9]{10}$'),
  statement text not null check (statement in ('income', 'balance', 'cashflow')),
  frequency text not null check (frequency in ('annual', 'quarterly')),
  basis text not null check (basis in ('latest', 'as_reported')),
  fiscal_year integer not null,
  fiscal_period text not null check (fiscal_period in ('FY', 'Q1', 'Q2', 'Q3', 'Q4')),
  period_start date,
  period_end date not null,
  line_items jsonb not null,
  -- Some line differs between the latest and the as-reported value.
  restated boolean not null default false,
  source text not null references market.data_providers,
  built_at timestamptz not null default now(),
  primary key (cik, statement, frequency, basis, period_end)
);

comment on table market.financial_statements is
  'Income, balance sheet and cash flow statements per CIK and period, built from XBRL facts.';
comment on column market.financial_statements.line_items is
  'Map of line id to {value (decimal string), concept, unit, accession, filed, derived?}.';

alter table market.financial_statements enable row level security;
