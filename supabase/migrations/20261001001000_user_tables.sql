-- Per-user tables (Phase 1 steps F3, G1, I1, J1). One owner today (ADR-015, ADR-018): the local
-- server connects as the owner of these tables and always filters by the owner's user_id. The
-- RLS policies below are what a Supabase deploy with signed-in users relies on: each user sees
-- and changes only their own rows, and anonymous clients see nothing.

create table public.watchlists (
  watchlist_id bigint generated always as identity primary key,
  user_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.watchlist_items (
  watchlist_id bigint not null references public.watchlists on delete cascade,
  user_id uuid not null,
  security_id bigint not null references market.securities,
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (watchlist_id, security_id)
);
create index watchlist_items_user_idx on public.watchlist_items (user_id);

create table public.saved_screens (
  screen_id bigint generated always as identity primary key,
  user_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.portfolios (
  portfolio_id bigint generated always as identity primary key,
  user_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  base_currency text not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  benchmark_ticker text not null default 'SPY',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.transactions (
  transaction_id bigint generated always as identity primary key,
  portfolio_id bigint not null references public.portfolios on delete cascade,
  user_id uuid not null,
  security_id bigint references market.securities,
  type text not null
    check (type in ('buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'fee')),
  trade_date date not null,
  quantity numeric check (quantity is null or quantity > 0),
  price numeric check (price is null or price >= 0),
  -- Cash amount for dividends, deposits, withdrawals and fees; for trades, quantity × price.
  amount numeric,
  fees numeric not null default 0 check (fees >= 0),
  notes text,
  source text not null default 'manual' check (source in ('manual', 'csv')),
  created_at timestamptz not null default now(),
  check ((type in ('buy', 'sell')) = (security_id is not null and quantity is not null and price is not null))
);
create index transactions_portfolio_idx on public.transactions (portfolio_id, trade_date);

create table public.alerts (
  alert_id bigint generated always as identity primary key,
  user_id uuid not null,
  security_id bigint not null references market.securities,
  kind text not null check (kind in ('price_above', 'price_below', 'pct_move', 'earnings_upcoming')),
  params jsonb not null default '{}',
  active boolean not null default true,
  cooldown_hours integer not null default 24 check (cooldown_hours between 0 and 720),
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index alerts_active_idx on public.alerts (security_id) where active;

create table public.alert_events (
  event_id bigint generated always as identity primary key,
  alert_id bigint not null references public.alerts on delete cascade,
  user_id uuid not null,
  -- The end-of-day bar that triggered it: at most one event per alert and bar (idempotent).
  bar_date date not null,
  message text not null,
  fired_at timestamptz not null default now(),
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'failed', 'suppressed')),
  delivered_at timestamptz,
  error text,
  unique (alert_id, bar_date)
);

create table public.audit_logs (
  audit_id bigint generated always as identity primary key,
  user_id uuid,
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}',
  at timestamptz not null default now()
);
create index audit_logs_user_idx on public.audit_logs (user_id, at desc);

-- Row-level security: own rows only. audit_logs is read-only to clients (the server writes it).
do $$
declare
  t text;
begin
  foreach t in array array['watchlists', 'watchlist_items', 'saved_screens', 'portfolios',
    'transactions', 'alerts', 'alert_events', 'audit_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['watchlists', 'watchlist_items', 'saved_screens', 'portfolios',
    'transactions', 'alerts', 'alert_events']
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own_rows', t);
  end loop;
end
$$;

create policy audit_logs_read_own on public.audit_logs for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on public.audit_logs from authenticated;
