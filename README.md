# Market Analysis

Personal stock market analytics app (for the owner's own use only, ADR-015). It is **not** a broker or an investment adviser. `CLAUDE.md` is the standing specification; `docs/` holds the architecture, data sources, decisions, runbook and compliance notes.

**Status:** Phases 0 and 1 are complete (`docs/plans/PHASE_0_REPORT.md`, `docs/plans/PHASE_1_REPORT.md`). Everything runs on synthetic data until the owner adds a Tiingo key; the live checks that need keys are listed in the Phase 1 report.

## Layout

| Path                   | What                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker`          | ingestion jobs, calendar-driven scheduler, staleness monitor, failover, screener snapshot, calendars, alert evaluation and email, operator CLI     |
| `apps/web`             | Next.js app for the owner (password login): Markets, ticker pages, screener, watchlists, portfolio, calendar, heatmap, alerts, data health         |
| `packages/market-data` | provider interface, Tiingo/SEC EDGAR/FRED/Finnhub/synthetic adapters, licenses, validation, adjustments, rate limiter, financial statement builder |
| `packages/indicators`  | technical indicators matching TA-Lib                                                                                                               |
| `packages/screener`    | screen schema, whitelisted SQL compiler, oracle, presets, snapshot math                                                                            |
| `packages/alerts`      | alert conditions, evaluator and wording                                                                                                            |
| `packages/portfolio`   | ledger replay, lots and splits, TWR, XIRR, drawdown, CSV import                                                                                    |
| `packages/calendar`    | NYSE/Nasdaq trading calendar                                                                                                                       |
| `packages/db`          | Kysely client, migration runner, security audit, test databases                                                                                    |
| `packages/config`      | validated env                                                                                                                                      |
| `packages/ui`          | design system (Tailwind, Radix, tokens)                                                                                                            |
| `packages/compliance`  | compliance copy, data labels and banners                                                                                                           |
| `supabase/`            | migrations and their tested rollback scripts                                                                                                       |

## Quickstart

Requirements: Node 24 (22.19+ works), pnpm 10, Postgres 17 and Redis 7 (`docker compose up -d`, or native installs).

```sh
pnpm install
cp .env.example .env                  # local values only; never commit .env
pnpm web:hash-password                # paste the two printed lines into .env
pnpm db:shim && pnpm db:migrate
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic
pnpm worker screener                  # screener and heatmap snapshot
pnpm lint && pnpm typecheck && pnpm test
TEST_DATABASE_URL=... TEST_REDIS_URL=... pnpm test:int
pnpm web                              # http://127.0.0.1:3000
pnpm --filter @market/web build && pnpm --filter @market/web test:e2e   # Playwright, axe, Lighthouse
```

More commands, operations and incident handling: `docs/RUNBOOK.md`.

All data in development and test is synthetic (`TEST_` tickers). Real market data must never be committed, or shown to anyone else without a display license (`docs/DATA_SOURCES.md`).
