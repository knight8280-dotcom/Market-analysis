-- Phase 2 group F: the owner's chart drawings (step F1) and dashboard layout (step F2).

-- Drawings on a security's chart. Points are {time: 'YYYY-MM-DD', price} on the price basis the
-- drawing was made on (raw or adjusted closes), so a split never moves a drawing; one point for a
-- horizontal line or a text label, two for the others.
create table public.chart_drawings (
  drawing_id bigint generated always as identity primary key,
  user_id uuid not null,
  security_id bigint not null references market.securities on delete cascade,
  kind text not null
    check (kind in ('trendline', 'horizontal', 'fibonacci', 'rectangle', 'text')),
  basis text not null check (basis in ('raw', 'adjusted')),
  points jsonb not null
    check (jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 1 and 2),
  label text check (length(label) between 1 and 100),
  created_at timestamptz not null default now()
);
create index chart_drawings_user_security_idx on public.chart_drawings (user_id, security_id);

-- One dashboard per user: the widgets in order, each with its size and whether it is shown.
create table public.dashboard_layouts (
  user_id uuid primary key,
  layout jsonb not null check (jsonb_typeof(layout) = 'array'),
  updated_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['chart_drawings', 'dashboard_layouts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own_rows', t);
  end loop;
end
$$;
