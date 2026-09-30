-- Securities master (spec §3.7): a stable internal security_id independent of ticker, with symbol
-- history (tickers get reused) and vendor symbol mappings. Delisted securities are never deleted.

create table market.securities (
  security_id bigint generated always as identity primary key,
  ticker text not null,
  name text not null,
  asset_class text not null check (asset_class in (
    'equity', 'etf', 'fund', 'adr', 'preferred', 'warrant', 'right', 'unit', 'index',
    'option', 'crypto', 'fx', 'future'
  )),
  exchange_mic text check (exchange_mic ~ '^[A-Z0-9]{4}$'),
  cik text check (cik ~ '^[0-9]{10}$'),
  figi text check (figi ~ '^[A-Z0-9]{12}$'),
  sector text,
  industry text,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  listed_at date,
  delisted_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint securities_listing_order check (
    delisted_at is null or listed_at is null or delisted_at >= listed_at
  )
);
comment on column market.securities.ticker is 'Current (or last) ticker; history lives in security_symbol_history.';
create index securities_ticker_idx on market.securities (ticker);
create index securities_cik_idx on market.securities (cik) where cik is not null;
alter table market.securities enable row level security;

-- valid_to is exclusive; null means "still current". The exclusion constraint stops one ticker
-- from pointing at two securities at the same time while still allowing reuse after a delisting.
create table market.security_symbol_history (
  security_id bigint not null references market.securities on delete cascade,
  ticker text not null,
  valid_from date not null,
  valid_to date,
  primary key (security_id, valid_from),
  constraint security_symbol_history_range check (valid_to is null or valid_to > valid_from),
  constraint security_symbol_history_no_overlap exclude using gist (
    ticker with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);
alter table market.security_symbol_history enable row level security;

-- How each vendor spells a security (e.g. BRK-B vs BRK.B), over time.
create table market.provider_symbols (
  security_id bigint not null references market.securities on delete cascade,
  source text not null references market.data_providers,
  source_symbol text not null,
  source_security_id text,
  valid_from date not null,
  valid_to date,
  primary key (source, source_symbol, valid_from),
  constraint provider_symbols_range check (valid_to is null or valid_to > valid_from),
  constraint provider_symbols_no_overlap exclude using gist (
    source with =,
    source_symbol with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);
comment on column market.provider_symbols.source_security_id is 'Vendor permanent identifier, when the vendor has one.';
create index provider_symbols_security_idx on market.provider_symbols (security_id);
create index provider_symbols_source_id_idx on market.provider_symbols (source, source_security_id)
  where source_security_id is not null;
alter table market.provider_symbols enable row level security;
