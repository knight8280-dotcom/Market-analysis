# Phase 0 Report: Foundations and Data Layer

**Dates:** plan approved and implemented 2026-09-30.
**Branch:** `claude/dazzling-edison-hoszan`.
**Commits:** 15, Conventional Commits.
**Result:** all 5 acceptance criteria met. The live EDGAR run was completed after the owner supplied a name and contact email.

![Data-health page against the local 500-ticker database](phase0-data-health.png)

## Acceptance criteria

| Criterion                                                            | Result  | Evidence                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 years of daily bars for a 500-ticker universe ingest idempotently | **Met** | `apps/worker/test/backfill.acceptance.test.ts` (CI step "Phase 0 acceptance"). 1,251,786 bars; the second pass inserts 0 and updates 0, with 0 duplicate keys and 0 rows in DEFAULT. Also run through the CLI: 83s first pass, 58s second pass                                               |
| Split fixtures produce correct adjusted series                       | **Met** | 4:1, 20:1 and 1:10 reverse splits: adjusted price = raw × factor and adjusted volume = raw ÷ factor before the ex-date; the move across the ex-date is < 20% while raw moves by the ratio (acceptance test, `adjustments.test.ts`, `ingest.int.test.ts`)                                     |
| EDGAR companyfacts for 50 companies without a single 403/429         | **Met** | Live run 2026-09-30 (`pnpm worker edgar --tickers <50 large caps>`): 50/50 companies, 101 requests, **all HTTP 200** (no 403 or 429), 1,461,821 facts and 119,717 filings in 144s. The first attempt found 2 real-world shape variations; they were fixed and all 50 re-run (see bugs 6-9)   |
| Staleness alerts fire in a simulated outage                          | **Met** | `apps/worker/test/monitor.int.test.ts`: primary down at 18:31 ET → critical staleness alert → failover → fallback backfills the session → alert resolves → 3 healthy probes → failback. Also the failure-threshold path, the no-fallback path, and a regression test for the failback streak |
| CI is green                                                          | **Met** | Every push on this branch passed (checks, Postgres 17/Redis 7 integration with round trip, codegen drift, integration and acceptance, security scan)                                                                                                                                         |

## Demo script

```sh
# 1. Services and schema
docker compose up -d && pnpm install && cp .env.example .env
pnpm db:shim && pnpm db:migrate

# 2. Ten years x 500 synthetic tickers, twice (second run: inserted 0)
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic
pnpm worker backfill --from 2016-01-04 --to 2025-12-31 --source synthetic

# 3. Split adjustment, raw vs adjusted, across TEST_SPLIT20's 20:1 ex-date
psql "$DATABASE_URL" -c "select p.date, p.close raw, a.close adjusted, a.split_factor
  from market.prices_daily p join market.prices_daily_adjusted a using (security_id, date, source)
  join market.securities s using (security_id)
  where s.ticker='TEST_SPLIT20' and p.date between '2022-07-14' and '2022-07-19' order by 1"

# 4. Freshness: the data ends 2025-12-31, so the monitor raises a critical staleness alert
pnpm worker monitor

# 5. Data-health page (Basic auth from .env): alert banner, SAMPLE DATA banner, runs, issues
pnpm --filter @market/web dev   # open http://localhost:3000/admin/data-health

# 6. The simulated outage, end to end
TEST_DATABASE_URL=... TEST_REDIS_URL=... pnpm --filter @market/worker exec vitest run --config vitest.int.config.ts test/monitor.int.test.ts
```

## Test results

| Suite                          | Tests        | Covers                                                                                                                                                                                                                                         |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                           | **165**      | config 14, calendar 30, db 4, market-data 90 (including recorded live EDGAR responses), compliance 3, worker 10, web 14                                                                                                                        |
| Integration (Postgres + Redis) | **40**       | db 19 (constraints, partitions, RLS/privilege audit), market-data 3 (rate limiter, fresh connection, fail closed), worker 16 (ingest, idempotency, corrections, outage/failover, BullMQ dedupe/DLQ), web 2 (health data never contains prices) |
| Acceptance                     | **2**        | 500 × 10y idempotency; split adjustment                                                                                                                                                                                                        |
| Migration round trip           | 6 migrations | rolling back k and re-applying restores an identical fingerprint, for every k                                                                                                                                                                  |

Local runs used Postgres 16 (sandbox) and Redis 7; CI runs Postgres 17 and Redis 7. Both are green.

## Bugs found and fixed during the phase

1. `HttpClient` let `undefined` options overwrite its defaults. The SEC client would have run with no retries and no `fetch`. Regression test added.
2. PUBLIC could execute the partition function: per-schema default privileges cannot revoke the global default. The security audit caught it; the function now revokes it explicitly.
3. Failover and failback in the same monitor tick, from a pre-outage success streak. Found by running against the 500-ticker database (ADR-011). The regression test fails without the fix.
4. Rejected-row counts undercounted conflicting duplicates (4 bars counted as 3).
5. Tiingo and EDGAR fixture values resembled real company data. Replaced with obviously synthetic values.
6. The SEC rate limiter failed closed on a fresh process's first request: with the offline queue disabled, a command sent while the Redis connection was still opening failed at once. It now waits up to 2s for the connection. The new test fails without the fix.
7. EDGAR `acceptanceDateTime` is true UTC, not Eastern as assumed (ADR-012 superseded). Checked against Apple's FY2025 10-K index page ("Accepted 2025-10-31 06:01:26" ET = 10:01:26Z). Stored filing times had been 4-5h late (conservative, but wrong). Filings now self-heal on re-ingest.
8. companyfacts `cik` arrives as a numeric string for some newer registrants (ExxonMobil Holdings Corp, CIK 2115436). Accepted, and checked against the CIK requested.
9. companyfacts facts with `fy: 0` and `fp: ""` (Wells Fargo 8-K exhibit facts) are stored with no fiscal period instead of failing the whole company.

## How implementation departed from the plan

- **Rate limiter:** the plan's "token bucket" became a sliding-window log. A bucket can allow 2× the rate across a window edge (ADR-006).
- **New table `ops.dataset_routing`,** plus a `provider_health.consecutive_successes` column, to persist routing and failback state across processes. Migration 6 was edited in place; it has never been deployed.
- **Staleness failover** only reroutes when a fallback exists, and failback counts from the failover (ADR-011).
- **Job ids use `/`** instead of `:` (BullMQ constraint, ADR-010).
- **Extra queues and jobs:** `ingest-macro`, `maintenance`, `monitor`, `dead-letter`, `schedule-edgar`. Extra worker modules: `runtime.ts`, `dispatch.ts`, `http-stats.ts`, `freshness.ts`.
- **Calendar files** are `dates.ts`, `timezone.ts`, `holidays.ts` (holidays, early closes and special closures together) and `sessions.ts`, instead of four holiday files.
- **`@market/db` entry points split** (client/types; `/migrations`; `/security`; `/testing`), because Turbopack cannot bundle the runner's directory URLs.
- **EDGAR fixtures** are hand-built for detailed cases, plus trimmed live recordings (Apple and the two edge cases) made after the owner supplied a contact.
- **Tiingo `getSecurities`** requires configured asset classes rather than guessing.
- **Acceptance test** gets its own Vitest config and CI step. `pnpm build` (Next production build) added to CI.
- **License check** approves libvips (LGPL, via sharp) as ADR-009.

## Known issues

1. **Tiingo adapter shape and `Authorization: Token` header unverified.** Verify with one personal-key request per endpoint; never commit the response.
2. **Spin-off and merger price adjustments** are not applied; they are recorded as `action_not_adjusted` issues.
3. **EDGAR** reads only recent filings (`filings.recent`). Older pages and the bulk `submissions.zip`/`companyfacts.zip` path are Phase 1.
4. **FRED pagination** is not implemented. The adapter refuses a truncated response rather than silently dropping data (series of up to 100,000 observations are fine).
5. **Least-privilege database roles:** web and worker connect as the database owner locally. Create separate roles when deploying (Phase 1).
6. **No CSP yet** (nonce-based CSP is Phase 1). Security headers and noindex are in place.
7. **Access control is HTTP Basic** for the admin page. Personal use needs only single-owner access; Supabase Auth matters only for a cloud deploy (Phase 1 plan).
8. **The migration history table** mirrors the Supabase CLI's; confirm with `supabase migration list` on the first real project.
9. **Observability** is structured logs plus `ops` tables. Sentry and OpenTelemetry are Phase 1.
10. **Repository housekeeping:**
    - This branch became the repository's default branch, because it was the first branch pushed.
    - Dependabot opened four PRs against it (checkout v7, setup-node v7, pnpm/action-setup v6, gitleaks-action v3). Those versions are already in `ci.yml`, so the PRs can be closed.
    - You may want a `main` branch.

## Cost snapshot

- **Spent: $0.** Work ran in the development sandbox and on GitHub Actions. Each push uses about 5 runner-minutes. The repository is public, so Actions minutes are free.
- **No vendor accounts** were created, and nothing was provisioned on Supabase, Render or Vercel. The EDGAR run used SEC's free public API.
- **Projected for Phase 1, personal use** (see `PHASE_1_PLAN.md`):
  - data: $0 on Tiingo's free tier, or about $30/month for Tiingo Power if full-market screening is wanted;
  - hosting: $0 running locally, or roughly $35–45/month for an optional private cloud deploy (estimate; verify each vendor's current pricing).

  A public product would instead cost $400–1,300/month (brief Part E); that is no longer the plan.

## Phase 1 plan

Superseded by the owner's decision that this system is for **personal use only** (2026-09-30). The Phase 1 plan was rewritten for that scope: [`PHASE_1_PLAN.md`](PHASE_1_PLAN.md).
