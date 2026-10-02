drop table market.short_interest;
delete from market.data_providers where provider_id = 'finra';
alter table market.data_providers drop constraint data_providers_kind_check;
alter table market.data_providers add constraint data_providers_kind_check
  check (kind in ('synthetic', 'commercial', 'government'));
