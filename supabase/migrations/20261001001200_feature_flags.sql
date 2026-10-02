-- Phase 2 step A1: the owner's feature-flag overrides. Defaults live in code
-- (packages/config/src/flags.ts); a row here overrides one. Server-only, like the rest of ops.
create table ops.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  enabled boolean not null,
  updated_at timestamptz not null default now()
);
comment on table ops.feature_flags is
  'Owner overrides of feature-flag defaults defined in code; no row means the default applies.';

alter table ops.feature_flags enable row level security;
