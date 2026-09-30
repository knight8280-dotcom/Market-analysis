drop function market.ensure_prices_daily_partition(integer);
-- Dropping the partitioned parent drops every partition, including ones created after migration.
drop table market.prices_daily;
