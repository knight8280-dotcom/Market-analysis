-- Phase 2 step D2: the owner's saved DCF scenarios per security. `inputs` is the calculator's
-- input set (packages/valuation DcfInputs) exactly as saved; outputs are recomputed on load, so
-- a saved scenario never shows a stale result. Own rows only, like the other per-user tables.
create table public.valuation_scenarios (
  scenario_id bigint generated always as identity primary key,
  user_id uuid not null,
  security_id bigint not null references market.securities on delete cascade,
  name text not null check (length(name) between 1 and 100),
  inputs jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, security_id, name)
);
create index valuation_scenarios_user_idx on public.valuation_scenarios (user_id, security_id);

alter table public.valuation_scenarios enable row level security;
revoke all on public.valuation_scenarios from anon;
create policy valuation_scenarios_own_rows on public.valuation_scenarios for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
