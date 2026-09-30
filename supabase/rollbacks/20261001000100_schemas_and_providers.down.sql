-- The btree_gist extension is left installed: `create extension if not exists` cannot tell whether
-- this migration created it, and dropping a shared extension could break other objects.
drop table market.data_providers;
drop schema ops;
drop schema market;
