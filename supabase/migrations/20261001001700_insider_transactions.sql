-- Phase 2 step H1: insider transactions from Form 4 and 4/A ownership documents (SEC EDGAR,
-- public domain). One row per filing with its reporting owners, and one per transaction line as
-- filed. Keyed by the issuer's CIK, not a security: a Form 4 names the class it covers only in
-- free text ("Class A Common Stock"), so every listing of the issuer shows the filings as filed.
-- An amendment is kept beside the filing it amends: a 4/A carries only the lines it adds or
-- corrects (Form 4 General Instruction 9), so nothing is merged or netted.
create table market.insider_filings (
  accession_no text primary key check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  issuer_cik text not null check (issuer_cik ~ '^[0-9]{10}$'),
  issuer_name text not null,
  issuer_symbol text,
  form_type text not null check (form_type in ('4', '4/A')),
  filed_at timestamptz not null,
  period_of_report date not null,
  original_filing_date date,
  owners jsonb not null
    check (jsonb_typeof(owners) = 'array' and jsonb_array_length(owners) > 0),
  aff_10b5_1 boolean,
  no_longer_subject_to_section16 boolean not null default false,
  remarks text,
  footnotes jsonb not null default '{}' check (jsonb_typeof(footnotes) = 'object'),
  url text not null,
  schema_version text,
  source text not null default 'sec_edgar' references market.data_providers,
  fetched_at timestamptz not null,
  parser_version integer not null check (parser_version > 0),
  check (form_type = '4/A' or original_filing_date is null)
);
create index insider_filings_issuer_idx on market.insider_filings (issuer_cik, filed_at desc);
comment on column market.insider_filings.owners is
  'Reporting owners as filed: [{cik, name, is_director, is_officer, officer_title, is_ten_percent_owner, is_other, other_text}].';
comment on column market.insider_filings.aff_10b5_1 is
  'The Rule 10b5-1(c) check box; null on filings made before the box existed (2023).';

create table market.insider_transactions (
  accession_no text not null references market.insider_filings on delete cascade,
  line smallint not null check (line > 0),
  derivative boolean not null,
  security_title text not null,
  transaction_date date not null,
  deemed_execution_date date,
  code text not null check (code in ('P', 'S', 'V', 'A', 'D', 'F', 'I', 'M', 'C', 'E', 'H', 'O',
                                     'X', 'G', 'L', 'W', 'Z', 'J', 'K', 'U')),
  equity_swap boolean not null default false,
  shares numeric check (shares >= 0),
  price numeric check (price >= 0),
  acquired_disposed text check (acquired_disposed in ('A', 'D')),
  shares_after numeric check (shares_after >= 0),
  ownership text check (ownership in ('D', 'I')),
  ownership_nature text,
  conversion_price numeric check (conversion_price >= 0),
  exercise_date date,
  expiration_date date,
  underlying_title text,
  underlying_shares numeric check (underlying_shares >= 0),
  footnote_ids text[] not null default '{}',
  primary key (accession_no, line)
);
create index insider_transactions_purchase_idx on market.insider_transactions (transaction_date)
  where code = 'P';
comment on column market.insider_transactions.shares_after is
  'Shares held after this line on its own ownership line (direct, or one indirect holding).';

-- Filings that could not be read (no XML, or a document the parser refuses), so sweeps do not
-- fetch them again until the parser changes.
create table market.insider_filing_errors (
  accession_no text primary key check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  cik text not null check (cik ~ '^[0-9]{10}$'),
  error text not null,
  parser_version integer not null check (parser_version > 0),
  failed_at timestamptz not null default now()
);

alter table market.insider_filings enable row level security;
alter table market.insider_transactions enable row level security;
alter table market.insider_filing_errors enable row level security;
