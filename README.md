# Market Analysis

Stock market analytics publisher. It is **not** a broker or an investment adviser. `CLAUDE.md` is the standing specification; `docs/` holds the architecture, data sources, decisions, runbook and compliance notes.

**Status:** Phase 0 (foundations and data layer) is complete. See `docs/plans/PHASE_0_REPORT.md`.

## Layout

| Path                   | What                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/worker`          | ingestion jobs, calendar-driven scheduler, staleness monitor, failover, operator CLI                          |
| `apps/web`             | Next.js app; Phase 0 has only the internal `/admin/data-health` page                                          |
| `packages/market-data` | provider interface, Tiingo/SEC EDGAR/FRED/synthetic adapters, licenses, validation, adjustments, rate limiter |
| `packages/calendar`    | NYSE/Nasdaq trading calendar                                                                                  |
| `packages/db`          | Kysely client, migration runner, security audit, test databases                                               |
| `packages/config`      | validated env                                                                                                 |
| `packages/compliance`  | compliance copy and banners                                                                                   |
| `supabase/`            | migrations and their tested rollback scripts                                                                  |

## Quickstart

Requirements: Node 24 (22.12+ works), pnpm 10, Postgres 17 and Redis 7 (`docker compose up -d`, or native installs).

```sh
pnpm install
cp .env.example .env                  # local values only; never commit .env
pnpm db:shim && pnpm db:migrate
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic
pnpm lint && pnpm typecheck && pnpm test
TEST_DATABASE_URL=... TEST_REDIS_URL=... pnpm test:int
```

More commands, operations and incident handling: `docs/RUNBOOK.md`.

All data in development and test is synthetic (`TEST_` tickers). Real market data must never be committed, or shown to anyone else without a display license (`docs/DATA_SOURCES.md`).
