-- Phase 1: SIC codes from EDGAR submissions (sector and industry are derived from them; GICS
-- would need a license), and Finnhub as a personal-plan earnings source (ADR-015).

insert into market.data_providers (provider_id, display_name, kind) values
  ('finnhub', 'Finnhub', 'commercial');

alter table market.securities
  add column sic_code text check (sic_code ~ '^[0-9]{3,4}$');

comment on column market.securities.sic_code is
  'SEC Standard Industrial Classification code from EDGAR submissions.';
