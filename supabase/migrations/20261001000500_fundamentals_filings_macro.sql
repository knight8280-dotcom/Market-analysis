-- SEC EDGAR fundamentals and filings, and macro series (spec §2.3, §2.4).

-- XBRL facts keyed by CIK, not security_id: one registrant can list several share classes
-- (e.g. GOOG and GOOGL), so joins go through market.securities.cik. Each filing's copy of a fact
-- is kept, which point-in-time backtests need (a fact is known from filed_at, not period_end).
create table market.fundamentals_facts (
  cik text not null check (cik ~ '^[0-9]{10}$'),
  taxonomy text not null,
  concept text not null,
  unit text not null,
  value numeric not null,
  period_start date,
  period_end date not null,
  fiscal_year integer,
  fiscal_period text,
  form text not null,
  filed_at date not null,
  accession_no text not null check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  frame text,
  source text not null references market.data_providers,
  ingested_at timestamptz not null default now(),
  constraint fundamentals_facts_key unique nulls not distinct (
    accession_no, taxonomy, concept, unit, period_start, period_end
  )
);
comment on column market.fundamentals_facts.filed_at is 'EDGAR filing date (date only).';
create index fundamentals_facts_concept_idx
  on market.fundamentals_facts (cik, taxonomy, concept, period_end);
alter table market.fundamentals_facts enable row level security;

-- One filing can appear under several registrants (co-registrants, subsidiaries), so the key
-- includes the CIK.
create table market.filings (
  accession_no text not null check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  cik text not null check (cik ~ '^[0-9]{10}$'),
  form_type text not null,
  filed_at timestamptz not null,
  filing_date date not null,
  period date,
  primary_document text,
  items text[] not null default '{}',
  url text not null,
  storage_path text,
  summary_status text not null default 'none'
    check (summary_status in ('none', 'pending', 'done', 'failed')),
  source text not null references market.data_providers,
  ingested_at timestamptz not null default now(),
  primary key (accession_no, cik)
);
comment on column market.filings.filed_at is 'EDGAR acceptance time: when the filing became public.';
create index filings_cik_idx on market.filings (cik, filed_at desc);
create index filings_form_idx on market.filings (form_type, filed_at desc);
alter table market.filings enable row level security;

create table market.macro_series (
  series_id text primary key,
  source text not null references market.data_providers,
  title text not null,
  units text,
  frequency text,
  seasonal_adjustment text,
  last_updated timestamptz,
  observation_start date,
  observation_end date,
  ingested_at timestamptz not null default now()
);
alter table market.macro_series enable row level security;

-- value is NULL when the source reports the observation as missing (FRED's "."); it is never
-- zero-filled or interpolated (spec MUST-NOT #1).
create table market.macro_observations (
  series_id text not null references market.macro_series on delete cascade,
  date date not null,
  value numeric,
  realtime_start date not null,
  ingested_at timestamptz not null default now(),
  primary key (series_id, date)
);
alter table market.macro_observations enable row level security;
