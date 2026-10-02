-- Phase 2 steps B7 and B8: backtests. A strategy is a saved definition; a run is one request
-- to the worker (queued → running → succeeded, failed or cancelled) carrying everything needed
-- to reproduce it: the request as submitted, the code version and a fingerprint of the data it
-- ran on. Results live in their own table so that listing runs stays light. Own rows only, as
-- for the other per-user tables (migration 10); results are written by the worker alone.

create table public.strategies (
  strategy_id bigint generated always as identity primary key,
  user_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  -- The strategy JSON (packages/backtest schema version 1), possibly with $param references.
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.backtest_runs (
  run_id bigint generated always as identity primary key,
  user_id uuid not null,
  strategy_id bigint references public.strategies on delete set null,
  -- The strategy's name when the run was requested (the strategy may change or go later).
  name text not null check (length(name) between 1 and 100),
  kind text not null check (kind in ('single', 'sweep', 'walk_forward')),
  -- The whole request: strategy definition, parameter values to try, split and windows.
  request jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  code_version text,
  data_snapshot_id text check (data_snapshot_id ~ '^[0-9a-f]{64}$'),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (status <> 'succeeded'
    or (code_version is not null and data_snapshot_id is not null and finished_at is not null)),
  check (status <> 'failed' or (error is not null and finished_at is not null))
);
create index backtest_runs_user_idx on public.backtest_runs (user_id, created_at desc);
create index backtest_runs_pending_idx on public.backtest_runs (created_at)
  where status in ('queued', 'running');

create table public.backtest_results (
  run_id bigint primary key references public.backtest_runs on delete cascade,
  user_id uuid not null,
  -- Headline figures for run lists: total return, CAGR, Sharpe, drawdown, trades, benchmark.
  summary jsonb not null,
  -- The full report of one backtest: strategy, metrics, curves, monthly returns, trades and
  -- fills. For a sweep, the best combination's; none for a walk-forward (see validation).
  report jsonb,
  -- Split, sweep or walk-forward results, when the request asked for them.
  validation jsonb,
  -- What the run read: securities, sessions, sources and data notes.
  inputs jsonb not null,
  created_at timestamptz not null default now()
);
create index backtest_results_user_idx on public.backtest_results (user_id);

alter table public.strategies enable row level security;
alter table public.backtest_runs enable row level security;
alter table public.backtest_results enable row level security;
revoke all on public.strategies, public.backtest_runs, public.backtest_results from anon;

create policy strategies_own_rows on public.strategies for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy backtest_runs_own_rows on public.backtest_runs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy backtest_results_read_own on public.backtest_results for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on public.backtest_results from authenticated;
