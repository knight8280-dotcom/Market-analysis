-- Schemas for licensed market data and operational data.
--
-- Neither schema is in Supabase's API-exposed list, and client roles get no USAGE on either, so
-- the public anon key can never read licensed prices through the auto-generated REST API
-- (spec MUST-NOT #4, §8 scraping defenses). Only the server and worker read these schemas.

create extension if not exists btree_gist with schema extensions;

create schema market;
comment on schema market is 'Licensed and public market data. Server/worker access only.';

create schema ops;
comment on schema ops is 'Ingestion runs, data quality, provider health and alerts. Server/worker access only.';

revoke all on schema market from public, anon, authenticated;
revoke all on schema ops from public, anon, authenticated;

-- Every data source we store. Adding a source is a deliberate, reviewed change because each
-- source carries its own license terms (docs/DATA_SOURCES.md).
create table market.data_providers (
  provider_id text primary key check (provider_id ~ '^[a-z][a-z0-9_]*$'),
  display_name text not null,
  kind text not null check (kind in ('synthetic', 'commercial', 'government'))
);
alter table market.data_providers enable row level security;

insert into market.data_providers (provider_id, display_name, kind) values
  ('synthetic', 'Synthetic test data', 'synthetic'),
  ('tiingo', 'Tiingo', 'commercial'),
  ('twelvedata', 'Twelve Data', 'commercial'),
  ('massive', 'Massive', 'commercial'),
  ('sec_edgar', 'SEC EDGAR', 'government'),
  ('fred', 'FRED, Federal Reserve Bank of St. Louis', 'government'),
  ('treasury', 'U.S. Department of the Treasury', 'government');
