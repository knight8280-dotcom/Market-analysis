# Runbook

Commands assume the repository root, with env from `.env` (copy `.env.example`). The operator CLI is `pnpm worker <command>`; its full usage is in the header of `apps/worker/src/cli.ts`.

## Local setup

```sh
docker compose up -d                 # postgres:17 + redis:7 (or native installs)
pnpm install
cp .env.example .env                 # one .env at the root serves the worker, web app and db scripts
pnpm web:hash-password               # prompts for your password; paste both printed lines into .env
pnpm db:shim && pnpm db:migrate      # shim = local stand-in for Supabase roles; never on Supabase
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic   # ~1.5 min
pnpm web                             # http://127.0.0.1:3000, sign in with your password
pnpm --filter @market/worker start   # long-running worker + scheduler
```

## Owner login

- The web app binds to `127.0.0.1` and serves nothing without a session: pages redirect to `/login`, API routes answer 401 (ADR-018). Without `OWNER_PASSWORD_HASH` and `SESSION_SECRET` it answers 503 to everything.
- **Change the password:** run `pnpm web:hash-password` again and replace both lines in `.env`. Every existing session ends.
- **Locked out after 10 wrong passwords:** wait 15 minutes, or restart the web app.
- **Reaching it from another device** (for example over a VPN) needs the host name in `WEB_ALLOWED_HOSTS` and HTTPS in front; other host names get 421 (DNS-rebinding guard). Personal-plan data must still reach only you.

## Real data (once the Tiingo key arrives)

Personal use only (ADR-015): this data is for the owner's screen, never a public URL.

1. In `.env`: `APP_ENV=production` (this removes the SAMPLE DATA banner and makes the worker refuse synthetic data), `TIINGO_API_KEY=<key>`, `DATA_PROVIDER_PRIMARY=tiingo`, `DATA_PROVIDER_FALLBACK=none`, and for SEC data `EDGAR_ENABLED=true` with `SEC_CONTACT_EMAIL=<your email>`. Keep the key out of chat and commits.
2. `pnpm worker verify-tiingo` (3 requests). It parses live responses through the adapter and prints field names and counts only. Record the result and date under Tiingo in `DATA_SOURCES.md`; never save the response.
3. `pnpm worker bootstrap` loads the universe (`config/universe.json`), attaches SEC CIKs and SIC sectors, loads filings and fundamentals, then ten years of prices. On the free tier the price step is paced by the quota limiter: about 2 hours 40 minutes for 65 symbols. It is safe to stop and re-run; every step is idempotent.
4. `pnpm worker monitor` should report every SLO as OK. Then start the long-running worker (`pnpm --filter @market/worker start`), which keeps prices current after each close and refreshes SEC data nightly.

To add a symbol: add it to `config/universe.json` with its asset class, then run `pnpm worker bootstrap` again.

## Tests

| Command                              | Needs                                                                                                                 | Runs                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm test`                          | nothing                                                                                                               | unit tests                                                                       |
| `pnpm test:int`                      | `TEST_DATABASE_URL` (a disposable server; tests create and drop their own databases) and `TEST_REDIS_URL`             | integration tests                                                                |
| `pnpm test:acceptance`               | same                                                                                                                  | 500 tickers × 10 years, twice (~2–3 min)                                         |
| `pnpm db:roundtrip`                  | same                                                                                                                  | every rollback script, plus the schema fingerprint check                         |
| `pnpm db:codegen:check`              | same                                                                                                                  | generated types match the migrations                                             |
| `pnpm --filter @market/web test:e2e` | a built web app (`pnpm --filter @market/web build`) and `E2E_DATABASE_URL` pointing at a database with synthetic data | Playwright journeys with axe checks (WCAG 2.2 AA, no serious or critical issues) |

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
| 18:45                                      | screener snapshot rebuilt from the day's bars                | runs for `screener`               |
| 18:00 / 21:00                              | FRED series / EDGAR sweep: new CIKs, then filings (enabled)  | runs for `macro`, `filings`       |

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

## Live updates

Watchlists update in place when the worker loads new bars, if the web app has `REDIS_URL` (the same Redis as the worker; the root `.env` serves both). Without it the page says "Live updates off" and shows data as of page load.

## Screener

- The snapshot rebuilds at 18:45 ET; to rebuild now: `pnpm worker screener` (a few seconds). The page shows the snapshot's as-of date.
- Saved screens are rows in `public.saved_screens` for the owner's user id.

## Calendars and heatmap

- **Earnings** (optional, needs `FINNHUB_API_KEY`, a free personal key): the worker loads 14 days back to 90 days ahead at 06:30 ET; by hand: `pnpm worker earnings [--from 2026-10-01 --to 2026-12-31]`. Dates a company has moved are removed from the future part of the window. Without a key, the calendar still shows past report dates from 8-K Item 2.02 filings once EDGAR data is loaded.
- **First run with the Finnhub key: check the payload shape.** The adapter follows Finnhub's documentation (marked SHAPE UNVERIFIED in the code). Run `pnpm worker earnings`: a changed shape fails the job with the offending field paths (see `/admin/data-health`); matched events appear on `/calendar`. Never commit the response.
- **Economic releases** (needs `FRED_ENABLED=true` and `FRED_API_KEY`): release dates 7 days back to 60 ahead at 06:30 ET; by hand: `pnpm worker releases`. The calendar lists the major ones (jobs, CPI, PPI, GDP, PCE, retail sales, industrial production, JOLTS) with "Show all".
- **Dividends and splits** come from the price source's corporate actions (last 60 days).
- **.ics export:** "Download .ics" on each calendar tab, signed in. It is a download, not a subscription link, so nothing is reachable without the owner's session; re-import after a refresh (event ids are stable, so calendar apps update rather than duplicate).
- **Heatmap** (`/heatmap`) reads the screener snapshot (`pnpm worker screener` rebuilds it). Tiles are sized by market cap (SEC shares outstanding × close); securities without shares outstanding are left out and counted, and when none has a market cap (synthetic data) the map sizes by 30-day dollar volume instead.

## Alerts

- The worker evaluates alerts at 18:50 ET; to run now: `pnpm worker alerts` (prints what fired and what was emailed). Re-running is safe: nothing fires twice for the same bar.
- **Email setup** (optional; without it events are listed on `/alerts` as "Not emailed"): create a free Resend account with your own address, create an API key, and set `RESEND_API_KEY` and `ALERT_EMAIL_TO` (that same address) in `.env`. The default sender, `onboarding@resend.dev`, delivers only to the account's own address, which is all personal use needs. `ALERT_DAILY_CAP` (default 20) limits emails per day; the rest are recorded as suppressed.
- **A failed email** (status "Failed" with Resend's error) is retried by the job's own retries; if it keeps failing, check the key and address, then run `pnpm worker alerts` again. Failed events older than a day are not retried.
- To check delivery end to end without Resend, point `RESEND_API_URL` at a local capture server (the E2E test does this).

## Financial statements

- Built automatically after each companyfacts load (`build-statements` job). To rebuild by hand: `pnpm worker statements` (all registrants, a few seconds for 50) or `--ciks 320193,789019`.
- **Check them against SEC's rendering** (live, 4 requests per company, needs `EDGAR_ENABLED=true`): `pnpm worker check-statements [--ciks …]`. Pass when every statement reports `mismatches: []`. `notPresented` lists values that come from the notes rather than the statement face; they are not errors. Last run: 2026-09-30, 10 companies, 301 values, 0 mismatches.

## Recording vendor fixtures (Tiingo and other commercial vendors)

**Never commit commercial vendor responses.** Use a personal key locally:

```sh
curl -s -H "Authorization: Token $TIINGO_API_KEY" "https://api.tiingo.com/tiingo/daily/spy/prices?startDate=2024-01-02&endDate=2024-01-05"
```

Compare the field names and types with `packages/market-data/test/fixtures/tiingo/*.json`. Update the adapter and synthetic fixtures if needed, and record the verification date in `DATA_SOURCES.md`.

## Secrets

- Locally, secrets live only in the root `.env` (gitignored). A cloud deploy would use the platform secret managers.
- Rotate yearly, or at once if exposed: `TIINGO_API_KEY`, `FRED_API_KEY`, `FINNHUB_API_KEY`, `RESEND_API_KEY`, the owner password (`OWNER_PASSWORD_HASH`), `SESSION_SECRET`, and database and Redis credentials.
- The worker and web app read secrets only through `packages/config`, which redacts values from errors and logs.
