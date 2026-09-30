alter table market.securities drop column sic_code;
delete from market.data_providers where provider_id = 'finnhub';
