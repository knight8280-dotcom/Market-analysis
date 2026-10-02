-- Phase 2 step H2: institutional holdings from SEC's quarterly Form 13F data sets (public
-- domain), tied to our securities by CUSIP through SEC's fails-to-deliver files (ADR-032).

-- CUSIPs of our securities, from the fails-to-deliver files' CUSIP, ticker and issue name
-- columns. A security can have several (a new CUSIP after a corporate action).
create table market.security_cusips (
  cusip text primary key check (cusip ~ '^[0-9A-Z*@#]{9}$'),
  security_id bigint not null references market.securities on delete cascade,
  symbol text not null,
  description text not null,
  first_seen date not null,
  last_seen date not null check (last_seen >= first_seen),
  source text not null default 'sec_edgar' references market.data_providers,
  updated_at timestamptz not null default now()
);
create index security_cusips_security_idx on market.security_cusips (security_id);
comment on column market.security_cusips.description is
  'The issue name in the fails-to-deliver file (SEC cuts it to 30 characters).';

-- Data sets read, one per three months of filing dates.
create table market.form13f_data_sets (
  name text primary key check (name ~ '^[0-9]{2}[a-z]{3}[0-9]{4}-[0-9]{2}[a-z]{3}[0-9]{4}_form13f\.zip$'),
  url text not null,
  window_start date not null,
  window_end date not null check (window_end >= window_start),
  ingested_at timestamptz not null,
  filings integer not null check (filings >= 0),
  holdings integer not null check (holdings >= 0),
  infotable_rows bigint not null check (infotable_rows >= 0),
  -- Filings whose information table has a different number of rows than their summary page says.
  row_count_mismatches text[] not null default '{}'
);

-- Every 13F filing in a data set for a period we keep (holdings reports, notices, amendments).
create table market.form13f_filings (
  accession_no text primary key check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  filer_cik text not null check (filer_cik ~ '^[0-9]{10}$'),
  filer_name text not null,
  submission_type text not null check (submission_type in ('13F-HR', '13F-HR/A', '13F-NT', '13F-NT/A')),
  report_type text not null,
  report_period date not null,
  filed_on date not null,
  amendment_type text check (amendment_type in ('RESTATEMENT', 'NEW HOLDINGS')),
  table_entry_total integer,
  table_value_total numeric,
  data_set text not null references market.form13f_data_sets on delete cascade
);
create index form13f_filings_filer_idx on market.form13f_filings (filer_cik, report_period);
create index form13f_filings_period_idx on market.form13f_filings (report_period);

-- One filing's share rows in one of our securities' CUSIPs, summed (puts, calls and principal
-- amounts left out).
create table market.form13f_holdings (
  accession_no text not null references market.form13f_filings on delete cascade,
  security_id bigint not null references market.securities on delete cascade,
  cusip text not null,
  shares numeric not null check (shares >= 0),
  value_usd numeric not null check (value_usd >= 0),
  rows integer not null check (rows > 0),
  primary key (accession_no, security_id, cusip)
);
create index form13f_holdings_security_idx on market.form13f_holdings (security_id);

-- Each filer's position at each quarter end as filed: the latest holdings report or
-- restatement, plus the NEW HOLDINGS amendments filed after it (spec §4
-- institutional_holdings). Rebuilt for a filer and period whenever its filings change.
create table market.institutional_holdings (
  security_id bigint not null references market.securities on delete cascade,
  report_period date not null,
  filer_cik text not null check (filer_cik ~ '^[0-9]{10}$'),
  filer_name text not null,
  shares numeric not null check (shares >= 0),
  value_usd numeric not null check (value_usd >= 0),
  filed_on date not null,
  accession_nos text[] not null check (cardinality(accession_nos) > 0),
  primary key (security_id, report_period, filer_cik)
);
create index institutional_holdings_filer_idx on market.institutional_holdings (filer_cik, report_period);

alter table market.security_cusips enable row level security;
alter table market.form13f_data_sets enable row level security;
alter table market.form13f_filings enable row level security;
alter table market.form13f_holdings enable row level security;
alter table market.institutional_holdings enable row level security;
