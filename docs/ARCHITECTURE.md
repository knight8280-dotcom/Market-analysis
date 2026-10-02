# Architecture

Status: Phase 1 complete (personal analytics app, ADR-015). The standing spec is `/CLAUDE.md`; decisions and their reasons are in `DECISIONS.md`.

## Topology

```
                 ┌──────────────────────────── apps/worker (Node, long-running) ─────────────────────────────┐
 vendors         │  scheduler tick (30s, market calendar) ──► BullMQ queues ──► job handlers ──► Postgres     │
 (Tiingo,  ◄─────┤  HttpClient (allowlist, backoff) ◄─ adapters ◄─ provider routing/failover                  │
  EDGAR, FRED,   │  Redis: queues, rate limiters (shared by all processes), market-events pub/sub            │
  Finnhub)       │  evaluate-alerts ──► notifications table; Resend HTTP API ──► the owner's own inbox        │
                 └────────────────────────────────────────────────────────────────────────────────────────────┘
                 ┌──────────────── apps/web (Next.js 16) ─────────────────┐
 owner ─────────►│ proxy.ts (owner session) ─► pages + /api ─► market.*, ops.* │  (no provider calls from the browser, ever)
                 └─────────────────────────────────────────────────────────┘
```

- **Postgres (Supabase, Postgres 17)** is the system of record. Local development and CI use stock `postgres:17` with a test-only shim for Supabase's roles.
- **Redis** backs BullMQ, the SEC and Tiingo rate limiters and the `market-events` pub/sub channel. The worker publishes `bars_updated` there after each end-of-day load; the web app holds one subscription per process and fans events out to open pages over server-sent events (`/api/stream`), at most one update per second per security.
- Browsers never talk to a data provider (MUST-NOT #4). All provider access is in the worker; the web app reads only our database.

## Packages

| Package                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`      | zod-validated env (`loadWorkerEnv`, `loadWebEnv`), secret redaction, production guards                                                                                                                                                                                                                                                                                                                                                               |
| `packages/db`          | Kysely client (`@market/db`), migration runner and schema fingerprint (`/migrations`), security audit (`/security`), test databases (`/testing`), generated types                                                                                                                                                                                                                                                                                    |
| `packages/calendar`    | NYSE/Nasdaq trading calendar: holidays, early closes, unscheduled closures, UTC sessions, DST                                                                                                                                                                                                                                                                                                                                                        |
| `packages/market-data` | canonical types, `MarketDataProvider`, adapters (Tiingo, SEC EDGAR, FRED, Finnhub, FINRA, synthetic), licenses, routing decisions, HttpClient, Redis rate limiter, validation rules, adjustment engine, statement builder, SEC report parser (ADR-020) Form 4 parser with a strict XML reader (ADR-031), and SEC bulk data set readers for 13F and fails-to-deliver files (ADR-032)                                                                  |
| `packages/ui`          | design system: Tailwind tokens (dark, light, system themes; AA contrast), shadcn-style components on Radix, command palette, number and date formatting                                                                                                                                                                                                                                                                                              |
| `packages/indicators`  | pure TypeScript technical indicators (averages, RSI, MACD, bands, ATR, stochastic, ADX/DI, CCI, %R, OBV, VWAP, channels, volatility, relative strength) matching TA-Lib; null warm-ups                                                                                                                                                                                                                                                               |
| `packages/screener`    | screen JSON schema, SQL compiler that emits only whitelisted identifiers and binds every value, independent oracle, presets, snapshot math (ADR-021)                                                                                                                                                                                                                                                                                                 |
| `packages/alerts`      | alert condition schema, pure evaluator (price, RSI and moving-average crossings, % moves, volume spikes, earnings dates, new filings, screen changes; cooldown and snooze) and wording shared by worker emails and the web pages (ADR-022, ADR-028)                                                                                                                                                                                                  |
| `packages/portfolio`   | ledger replay (FIFO lots, splits, implicit deposits), TWR, XIRR, drawdown, benchmark index, risk measures on session returns, CSV parsing and validation (ADR-023, ADR-026)                                                                                                                                                                                                                                                                          |
| `packages/metrics`     | one definition of each series statistic: returns, volatility, Sharpe, Sortino, drawdown, CAGR, beta, correlation, correlation matrix, concentration (ADR-026)                                                                                                                                                                                                                                                                                        |
| `packages/valuation`   | two-stage DCF, sensitivity grid, multiples, peer median and percentile, figures as known on a date (ADR-027)                                                                                                                                                                                                                                                                                                                                         |
| `packages/backtest`    | strategy JSON schema, deterministic engine on point-in-time data, metrics, parameter sweeps, out-of-sample split, walk-forward, run requests, data fingerprint (ADR-025)                                                                                                                                                                                                                                                                             |
| `packages/ownership`   | Form 4 transaction-code legend in SEC's wording, insider roles, open-market purchase and sale totals, clusters of purchases by several insiders (descriptive; ADR-031); CUSIP-to-listing matching by ticker and name (ADR-032)                                                                                                                                                                                                                       |
| `packages/news`        | news de-duplication: links compared without tracking parameters, headlines by shared words within two days (ADR-035)                                                                                                                                                                                                                                                                                                                                 |
| `packages/ai`          | Anthropic Messages API client (key in a header, fixed host, retries), model prices read from Anthropic's page, the monthly-cap arithmetic, the versioned news-sentiment prompt and its strict reply checks (ADR-036)                                                                                                                                                                                                                                 |
| `packages/compliance`  | compliance copy registry (§12), data labels (source, delay, as-of), SAMPLE DATA and stale-data banners, footer disclaimer                                                                                                                                                                                                                                                                                                                            |
| `apps/worker`          | job handlers, BullMQ runtime, scheduler, freshness SLOs, staleness monitor, alert delivery (Resend), backtest runner (worker thread), operator CLI                                                                                                                                                                                                                                                                                                   |
| `apps/web`             | Next.js app for the owner: login, Markets dashboard (eight widgets, arranged and saved per user), ticker pages (lazy-loaded Lightweight Charts, indicators in a Web Worker above 5, drawing tools; Financials, Valuation, Ownership and News tabs), screener, watchlists (SSE), portfolio, backtests, calendar (.ics), heatmap, alerts (one page per alert), notifications (header bell), data health, settings; ⌘K search; server-side queries only |

Internal packages export TypeScript source. Vitest, tsx and Next.js (Turbopack) compile it directly, so there is no separate package build step.

## Database

Migrations live in `supabase/migrations` (forward-only). Each has a rollback in `supabase/rollbacks`, and CI proves every rollback restores an identical schema (`pnpm db:roundtrip`).

### Schemas

| Schema   | Contents                                                                                                                                                                                                                                                                                                                                                                   | Access                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `market` | `data_providers`, `securities`, `security_symbol_history`, `provider_symbols`, `prices_daily` (+ partitions), `corporate_actions`, `adjustment_factors`, `prices_daily_adjusted` (view), `fundamentals_facts`, `filings`, `financial_statements`, `screener_snapshot`, `earnings_events`, `economic_releases`, `macro_series`, `macro_observations`                        | server/worker only                                      |
| `ops`    | `data_ingestion_runs`, `data_corrections`, `data_quality_issues`, `provider_health`, `dataset_routing`, `alerts`, `feature_flags` (owner overrides, ADR-024)                                                                                                                                                                                                               | server/worker only                                      |
| `public` | `watchlists`, `watchlist_items`, `saved_screens`, `portfolios`, `transactions`, `alerts`, `alert_events`, `strategies`, `backtest_runs`, `backtest_results`, `valuation_scenarios`, `notifications`, `chart_drawings`, `dashboard_layouts`, `audit_logs`: per-user rows (`user_id`) with RLS policies (own rows only; audit log and backtest results read-only to clients) | owner only (server); RLS for a future multi-user deploy |

`market` and `ops` are not in Supabase's API-exposed schema list, and client roles (`anon`, `authenticated`) have no `USAGE` on them. Every table, including every partition, has RLS enabled. `auditDatabaseSecurity()` checks all of this in CI and fails on any table without RLS, any client grant on a private schema, and any function a client role could execute.

### Securities master

- `security_id` is a stable internal id, independent of ticker.
- `security_symbol_history` records exchange tickers over time. An exclusion constraint stops one ticker from belonging to two securities at the same moment; reuse after a delisting is allowed.
- `provider_symbols` maps each vendor's spelling to a security, with validity ranges. Ingestion attributes every bar to a security by its date through these ranges, so a reused ticker's old history stays with the old security.
- Delisted securities are never deleted.

### Daily prices

`market.prices_daily` stores **raw** bars, range-partitioned by year:

- one partition for pre-2000;
- yearly partitions 2000–2028, extended by `market.ensure_prices_daily_partition(year)` from the `ensure-partitions` job;
- a `DEFAULT` partition that should stay empty, which the monitor alerts on.

The primary key is `(security_id, date, source)`; it also serves `(security_id, date DESC)` lookups through backward index scans. CHECK constraints (positive prices, `low <= open,close <= high`, `volume >= 0`) back up the ingest validator.

### Adjusted prices

Raw prints are never overwritten.

- `market.adjustment_factors` is a sparse step function. Row `(security, e)` holds the cumulative factors of every corporate action with `ex_date >= e`.
- `market.prices_daily_adjusted` (a `security_invoker` view) multiplies each raw bar by the row with the smallest `ex_date` after the bar's date. Volume is divided by the split factor.
- Splits and stock dividends with ratio _r_ (new shares per old) contribute `1/r`.
- A cash dividend _D_ contributes `1 − D / C`, where _C_ is the raw close on the previous trading day, converted to post-split units if a split shares the ex-date.
- A missing _C_, or _D ≥ C_, is reported as a data-quality issue rather than estimated.
- Spin-offs and mergers are stored but not price-adjusted (known issue; needs the distributed entity's value).
- `recompute-adjustments` rebuilds a security's factors whenever its actions change, then emits `adjustments_recomputed`. That event is the cache-invalidation hook.

### Fundamentals and filings

- `fundamentals_facts` holds XBRL facts keyed by CIK, not `security_id`, because one registrant can list several share classes. Joins go through `securities.cik`.
- Every filing's copy of a fact is kept (unique on accession, taxonomy, concept, unit and period, `NULLS NOT DISTINCT`), so backtests can use point-in-time `filed_at`.
- `filings` is keyed by `(accession_no, cik)`, because co-registrants share accession numbers.
- `insider_filings` (one Form 4 or 4/A, with its reporting owners as JSON and its footnotes) and `insider_transactions` (its lines as filed) are keyed by the issuer's CIK, like facts: a Form 4 names its share class only in free text. Amendments sit beside the filings they amend and are never netted against them (ADR-031). `insider_filing_errors` remembers documents the parser refused, by parser version.
- `security_cusips` ties CUSIPs from SEC's fails-to-deliver files to our listings. `form13f_data_sets`, `form13f_filings` and `form13f_holdings` (one filing's share rows in one of our securities, summed) keep 13F data as filed; `institutional_holdings` holds each filer's position per quarter end, rebuilt from them with restatements and new-holdings amendments applied (ADR-032).
- `short_interest` holds FINRA's figures per security and settlement date, revisions replacing earlier rows (ADR-033).

## Data flow

### Ingestion (`ingest-eod`, one vendor symbol and date range)

1. Resolve the provider: an explicit override (backfills), or the dataset's active route.
2. Fetch bars and corporate actions. Provider health records latency and success or failure, and failures count toward failover.
3. Map each bar to a security by date through `provider_symbols`. Unmapped bars are refused and recorded (`unmapped_symbol`).
4. Upsert corporate actions. New or changed actions queue `recompute-adjustments`.
5. Validate with `validateDailyBars`:
   - **rejected:** non-positive prices, inconsistent OHLC, negative or fractional volume, conflicting duplicates;
   - **collapsed:** identical duplicates;
   - **flagged but kept:** a move of more than 50% with no action on file, or a bar on a day the calendar says was closed.
6. Merge in one transaction. New bars are inserted and identical bars are left alone, so re-running changes nothing. Bars the vendor changed are updated, and their old and new values go to `ops.data_corrections`.
7. Record an `ops.data_ingestion_runs` row: counts, HTTP status counts for this run, and any error.

`reconcile-eod` re-ingests the last 5 trading days nightly, so late and corrected prints land through the same merge.

### Jobs and schedules

| Queue                 | Jobs                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest-eod`          | `ingest-securities`, `schedule-eod` (fan-out), `ingest-eod`, `reconcile-eod`                                                                                      |
| `ingest-fundamentals` | `ingest-fundamentals`, `build-statements`                                                                                                                         |
| `ingest-filings`      | `ingest-filings`, `schedule-edgar` (fan-out), `attach-edgar-ids`, `ingest-insider` (one Form 4), `sweep-insiders`, `refresh-cusips`, `ingest-13f`, `schedule-13f` |
| `ingest-macro`        | `ingest-macro`, `ingest-earnings`, `ingest-releases`, `ingest-short-interest` (FINRA)                                                                             |
| `maintenance`         | `recompute-adjustments`, `ensure-partitions`, `refresh-screener`                                                                                                  |
| `alerts-evaluate`     | `evaluate-alerts` (one at a time; queued as data arrives and at 18:50; ADR-028)                                                                                   |
| `monitor`             | `staleness-monitor`                                                                                                                                               |
| `backtest-run`        | `run-backtest` (one at a time, each in a worker thread; ADR-025)                                                                                                  |
| `dead-letter`         | jobs that exhausted retries or failed unrecoverably                                                                                                               |

`dueJobs(now)` is a pure function of the market calendar:

| When (exchange time)                                                    | Job                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| every minute                                                            | staleness monitor                                                           |
| 30 minutes after each session's close, including 1:00 p.m. early closes | EOD fan-out                                                                 |
| 02:00                                                                   | reconcile                                                                   |
| 03:00                                                                   | partitions                                                                  |
| 06:30                                                                   | earnings (Finnhub key) and economic releases (FRED)                         |
| 18:00                                                                   | macro                                                                       |
| 18:45                                                                   | screener snapshot (after the 18:30 EOD deadline)                            |
| 18:50                                                                   | every alert evaluated again, with email                                     |
| 19:30                                                                   | FINRA short interest, when its credential is set (ADR-033)                  |
| 21:00                                                                   | EDGAR sweep (off-peak)                                                      |
| 22:30                                                                   | Form 4 sweep: documents the evening's refresh did not read (ADR-031)        |
| 23:00                                                                   | 13F: one look at SEC's data set listing; any new data set is read (ADR-032) |

Besides the calendar, a 3-second poll enqueues backtests the owner queued (`run-backtest/<run id>`) and fails runs left running long after their time limit.

Alerts do not wait for 18:50: an end-of-day load that stores new bars queues `evaluate-alerts/bars/<run id>` for the price, RSI, moving-average and volume alerts on those securities; a filings refresh that stores new filings queues `evaluate-alerts/filings/<run id>` for new-filing alerts on that registrant; a screener rebuild queues `evaluate-alerts/screener/<run id>` for screen alerts. Each is queued only when such an alert is active.

Job ids are deterministic (`ingest-eod/2026-09-29/TEST_S001`), so re-dispatching is a no-op. Jobs retry 5 times with exponential backoff and jitter. Non-retryable provider errors (404, bad shape, license) become `UnrecoverableError`, and exhausted jobs go to the dead-letter queue.

### Freshness and failover

| Dataset              | SLO                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------- |
| daily_bars           | bars for the latest session due by 18:30 ET for ≥ 98% of securities listed that day |
| fundamentals         | XBRL facts for any 10-K/10-Q filed 24h–7d ago                                       |
| macro                | every series refreshed within 26h                                                   |
| prices_daily_default | empty                                                                               |

The monitor opens a `staleness` alert on a breach and resolves it on recovery. Routing decisions are pure functions in `packages/market-data/src/routing.ts`, persisted in `ops.dataset_routing`:

- **Failover** after 3 consecutive primary failures, or on a staleness breach **if a fallback exists**. It emits `provider_failover` and opens a `failover` alert. After a staleness failover the monitor immediately asks the fallback for the missing session. With no fallback, repeated failures route to "none": jobs fail fast, and readers serve last-good data with a staleness banner.
- **Failback** after 3 consecutive healthy probes of the primary, counted from the failover. It emits `provider_failback`.
- Bars keep their `source`, so a chart series that crosses a failover can mark the boundary (spec §2.1).

### SEC EDGAR access

- Every request declares `User-Agent: <APP_NAME> <SEC_CONTACT_EMAIL>`.
- Requests wait for a slot in a Redis sliding-window limiter (at most 8 grants in any 1-second window, across all processes, using Redis server time). If Redis is unreachable, no request is sent (fail closed).
- 403, 429 and 5xx responses are retried with backoff.
- New 10-K/10-Q filings trigger a companyfacts refresh for that CIK.
- New Form 4 and 4/A filings filed in the last 30 days trigger a read of their XML (`ingest-insider/<accession>/v<parser version>`); older ones are read by the sweep or `pnpm worker insiders`.

## Licensing controls in code

- `DATA_LICENSES` (`packages/market-data/src/licenses.ts`) states per provider whether data may be displayed, which datasets, the intraday delay, export rights and attribution. Uncontracted commercial providers cannot be displayed.
- `enforceDelay()` drops intraday prints newer than now − delay for non-entitled users.
- Every record carries `source`, `source_symbol`, `fetched_at`, `as_of` and `license_tier`.
- The env schema refuses the synthetic provider in production; the SAMPLE DATA banner shows wherever synthetic data exists.

## Deferred beyond Phase 1

Intraday storage (`prices_intraday_1m`, pg_partman) and live quotes, news, insiders and 13F, options, AI features (Phase 2b), billing and any multi-user or public product (ADR-015), least-privilege database roles for web and worker, a nonce-based CSP, OpenTelemetry/Sentry, and deployment (the optional private cloud deploy, plan group L, was not chosen).
