# Runbook

Commands assume the repository root, with env from `.env` (copy `.env.example`). The operator CLI is `pnpm worker <command>`; its full usage is in the header of `apps/worker/src/cli.ts`.

## Local setup

```sh
docker compose up -d                 # postgres:17 + redis:7 (or native installs)
pnpm install
cp .env.example .env                 # set DATABASE_URL, REDIS_URL, admin credentials
pnpm db:shim && pnpm db:migrate      # shim = local stand-in for Supabase roles; never on Supabase
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic   # ~1.5 min
pnpm --filter @market/web dev        # http://localhost:3000/admin/data-health (Basic auth)
pnpm --filter @market/worker start   # long-running worker + scheduler
```

## Tests

| Command                 | Needs                                                                                                     | Runs                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm test`             | nothing                                                                                                   | unit tests                                               |
| `pnpm test:int`         | `TEST_DATABASE_URL` (a disposable server; tests create and drop their own databases) and `TEST_REDIS_URL` | integration tests                                        |
| `pnpm test:acceptance`  | same                                                                                                      | 500 tickers × 10 years, twice (~2–3 min)                 |
| `pnpm db:roundtrip`     | same                                                                                                      | every rollback script, plus the schema fingerprint check |
| `pnpm db:codegen:check` | same                                                                                                      | generated types match the migrations                     |

## Migrations

- **Author:** `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`, plus `supabase/rollbacks/<same>.down.sql`. Run `pnpm db:roundtrip` and `pnpm db:codegen`, and commit both files and `packages/db/src/types.generated.ts`.
- **Production:** forward-only with `supabase db push`. Test on a copy of staging data first (MUST-NOT #9). If a release must be undone, run the matching rollback script by hand inside a transaction, then delete its row from `supabase_migrations.schema_migrations`.
- **Zero-downtime changes:** use expand/contract (add → backfill → switch readers → drop in a later release).

## Daily operation

| Time (ET)                                  | What happens                                                 | Where to look                     |
| ------------------------------------------ | ------------------------------------------------------------ | --------------------------------- |
| close + 30 min (13:30 on early-close days) | EOD fan-out, one `ingest-eod` job per listed symbol          | data-health page → Ingestion runs |
| 18:30                                      | EOD freshness deadline; the monitor alerts if coverage < 98% | page → alerts                     |
| 02:00                                      | reconcile the last 5 sessions (corrections logged)           | `ops.data_corrections`            |
| 03:00                                      | ensure this year's and next year's partitions exist          | alert kind `partition`            |
| 18:00 / 21:00                              | FRED series / EDGAR sweep (when enabled)                     | runs for `macro`, `filings`       |

### Incidents

**Staleness alert (`staleness`, daily_bars)**

1. Check provider health and the last run errors on the data-health page.
2. If a fallback is configured, the monitor has already failed over and re-requested the missing session. Confirm under Routing.
3. With no fallback, readers serve last-good data with a stale banner. Fix the cause, then run `pnpm worker eod --date <session>` and `pnpm worker monitor`.

**Failover alert (`failover`)**

- It resolves automatically after 3 healthy probes of the primary.
- To force routing back, delete the dataset's row in `ops.dataset_routing`; the next job recreates it from config. Do this only after confirming the primary works (`pnpm worker routing` shows the state).

**SEC 403s or 429s**

- The limiter targets 8 requests/second across all processes.
- Sustained 403s mean SEC is throttling or blocking us. Stop EDGAR jobs (`EDGAR_ENABLED=false`), check that the User-Agent has a real contact, and wait at least 10 minutes before resuming.

**Rows in the DEFAULT partition (`partition` alert)**

- A bar arrived for a year without a partition. Move it:

```sql
begin;
create temp table moved as select * from market.prices_daily_default;
delete from market.prices_daily_default;
select market.ensure_prices_daily_partition(<year>);
insert into market.prices_daily select * from moved;
commit;
```

**Dead-letter queue** (`dead-letter` in BullMQ)

- Inspect the job data and reason. Fix the cause, then re-dispatch with a new job id.
- Jobs are idempotent, so re-running is safe.

## Re-ingest (disaster recovery)

Raw data is re-fetchable, so after restoring a backup older than the RPO:

1. `pnpm worker ingest-securities`
2. `pnpm worker backfill --from <restore point date> --to <today>`
3. `pnpm worker recompute-adjustments`
4. `pnpm worker monitor`

The merge only inserts or corrects, so overlapping ranges are safe.

## EDGAR live run (Phase 0 acceptance; passed 2026-09-30)

1. Set `EDGAR_ENABLED=true`, `APP_NAME=<brand>` and `SEC_CONTACT_EMAIL=<real monitored address>`, with Redis running.
2. Run:

   ```sh
   pnpm worker edgar --tickers AAPL,MSFT,...   # 50 tickers
   ```

3. Pass when the output's `httpStatusCounts` has no `403` or `429`, and `ops.data_ingestion_runs` shows 50 succeeded `fundamentals` runs.
4. Afterwards, compare one `acceptanceDateTime` with the filing index page's "Accepted" time (`DATA_SOURCES.md`), and replace the hand-built fixtures with trimmed recordings. SEC data is public domain, so recordings may be committed.

## Recording vendor fixtures (Tiingo and other commercial vendors)

**Never commit commercial vendor responses.** Use a personal key locally:

```sh
curl -s -H "Authorization: Token $TIINGO_API_KEY" "https://api.tiingo.com/tiingo/daily/spy/prices?startDate=2024-01-02&endDate=2024-01-05"
```

Compare the field names and types with `packages/market-data/test/fixtures/tiingo/*.json`. Update the adapter and synthetic fixtures if needed, and record the verification date in `DATA_SOURCES.md`.

## Secrets

- Secrets live in the platform secret managers (Vercel, the worker host, Supabase vault).
- Rotate quarterly and whenever staff change: `TIINGO_API_KEY`, `FRED_API_KEY`, `ADMIN_BASIC_AUTH_PASSWORD`, and database and Redis credentials.
- The worker and web app read secrets only through `packages/config`, which redacts values from errors and logs.
