# Phase 0 Plan: Foundations and Data Layer

**Status:** approved 2026-09-30 (all defaults) and implemented. Results and every departure from this plan: [`PHASE_0_REPORT.md`](PHASE_0_REPORT.md).
**Scope source:** Phase 0 prompt in `docs/BRIEF.md` (Part C). **Rules source:** `/CLAUDE.md`.
**Prepared:** 2026-09-30

---

## (a) Goal, restated

Build the monorepo and a data layer that is correct, testable and licensed by design. There is no product UI in this phase.

When Phase 0 is done, a worker loads data into a partitioned Postgres schema that matches Supabase. The data comes from:

- a deterministic synthetic provider now, and a licensed provider once contracted (daily bars, securities, corporate actions);
- SEC EDGAR (companyfacts, submission/filing metadata);
- FRED (macro series).

Every load is:

- idempotent: re-running changes nothing;
- validated: bad bars are rejected or flagged, never "fixed";
- adjusted for splits and dividends without touching raw prints;
- scheduled from an NYSE/Nasdaq calendar, not naive cron;
- watched by a staleness monitor that opens alerts and triggers failover.

A password-protected internal page shows data health: metadata only, never prices. CI enforces all of this on every push.

## (b) Assumptions

1. **No licensed market-data contract yet.** Phase 0 is built and accepted against a seeded synthetic provider (`TEST_` tickers, `source = 'synthetic'`).
   - I'll build the primary-provider adapter from the vendor's public docs. It is tested against fixtures that match the vendor's response _shape_ but hold synthetic values.
   - I'll flag it "shape unverified" in `DATA_SOURCES.md` until it is recorded once against your personal-plan key (rule 9). Real vendor payloads never go into git, because committing them could count as redistribution.
2. **EDGAR and FRED are US-government public data.** Small, trimmed real responses may be committed as fixtures. FRED fixtures use only public-domain series (e.g., `DGS10`, `CPIAUCSL`, `UNRATE`, `GDP`), since some FRED series carry third-party copyright.
3. **Database.**
   - The target is Supabase Postgres 17. Local dev and CI use stock `postgres:17`. SQL must also run on Postgres 16, which is what this sandbox has.
   - A test-only shim creates Supabase's `anon`/`authenticated`/`service_role` roles and `auth.uid()`. The shim is never applied to Supabase.
4. **Market and ops data live in non-exposed schemas** (`market`, `ops`), not `public`. Supabase's auto-generated REST API would otherwise let anyone with the anon key read prices, which is both a license violation and a scraping hole. Only the server and worker read these schemas.
5. **No cloud infrastructure is provisioned in Phase 0.** There is no Supabase project, worker host, Redis or Vercel project yet. Everything runs locally and in GitHub Actions at $0. I'll ask before creating anything billable.
6. **Test universe.** It has 500 synthetic securities × 10 years ≈ 1.26M daily rows. It includes these scenarios:
   - 4:1 and 20:1 splits, and a 1:10 reverse split;
   - cash, special and stock dividends;
   - a delisting, a ticker reused by a new security, a symbol change and an IPO mid-history;
   - a halt/gap;
   - a >50% jump with no corporate action (must be flagged);
   - OHLC-inconsistent and negative-volume bars (must be rejected).
7. **Ops alerts** go to a structured log, an `ops.alerts` row and a banner on the data-health page. Email or Slack routing waits until you pick a channel.
8. **Corporate-action coverage.** Price adjustment covers splits, reverse splits, cash dividends and stock dividends. Spin-offs, mergers and symbol changes are _stored_, and symbol changes update symbol history. Spin-off price adjustment needs the spun-off entity's value, so it is deferred and listed as a known issue rather than approximated.
9. **Working practice.** Conventional Commits on `claude/dazzling-edison-hoszan`. No PR until you ask for one.

## (c) Open questions

Nothing blocks me from starting except your approval. Each item has a default that I'll use unless you say otherwise.

| #   | Question                                                                                        | My default / recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What it affects     |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | **Brand name, domain and contact email** for the SEC User-Agent (`[BRAND_NAME] admin@[DOMAIN]`) | Use a config placeholder until you decide. The **live** "EDGAR companyfacts for 50 companies" acceptance run waits for real values; SEC asks for a real contact.                                                                                                                                                                                                                                                                                                                                                             | One acceptance item |
| 2   | **Primary provider adapter** to build first                                                     | **Tiingo** (cheapest verified display path, Part E). It uses header auth (`Authorization: Token …`), so the key never appears in a URL. Twelve Data would be the second adapter.                                                                                                                                                                                                                                                                                                                                             | Step 20 only        |
| 3   | **Schema refinements** vs §4 (listed in (d) below)                                              | Apply them all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Migrations          |
| 4   | **pg_partman**: §3.2 says "managed with pg_partman"                                             | Don't depend on it for `prices_daily`. Instead: yearly partitions pre-created by migration, a `DEFAULT` catch-all, a worker job that creates next year's partition ahead of time, and an alert if any row lands in `DEFAULT`. Stock `postgres:17` has no pg_partman, and this keeps local, CI and prod identical. Revisit pg_partman for monthly intraday partitions in Phase 1.                                                                                                                                             | `prices_daily` DDL  |
| 5   | **Migration tooling** (§10 allows Drizzle, Prisma or Supabase migrations)                       | **Supabase-native migrations** (`supabase/migrations/*.sql`, forward-only, and they work with Supabase preview branching), each paired with a **rollback script** (`supabase/rollbacks/*.down.sql`) that CI tests up→down→up, as §10 asks. Queries use **Kysely**, with types generated from the migrated DB (`kysely-codegen`) and a CI drift check. I rejected Drizzle because it can't generate partitioned tables, RLS or exclusion constraints, so we'd hand-write SQL anyway and keep a second schema in sync by hand. | `packages/db`       |
| 6   | **Integration tests**: §10 says Testcontainers                                                  | Use GitHub Actions **service containers** (`postgres:17`, `redis:7`), with a fresh database per test file cloned from a template. The isolation is the same, and it works where no Docker daemon is available (this sandbox has none).                                                                                                                                                                                                                                                                                       | CI                  |
| 7   | **Admin page protection** before real auth exists (Phase 1)                                     | HTTP Basic auth from environment credentials (timing-safe compare), `noindex`, and metadata only: counts, timestamps, statuses, never prices                                                                                                                                                                                                                                                                                                                                                                                 | `apps/web`          |
| 8   | **Runtime and tool versions**                                                                   | Node 24 LTS in CI and `.nvmrc` (Node 22 reaches end-of-life in April 2027; code also passes on 22). TypeScript pinned to **6.0.x**: TS 7.0 is the npm `latest` tag, but typescript-eslint 8.71 supports only `<6.1.0`. Next.js 16, zod 4, BullMQ 6, Vitest 5, pnpm 10, Turborepo 2.                                                                                                                                                                                                                                          | Tooling             |
| 9   | **Cloud provisioning**                                                                          | Nothing in Phase 0. Your connected Render/Supabase/Vercel accounts fit §3.1, and I'll propose a provisioning step with costs at the Phase 1 plan.                                                                                                                                                                                                                                                                                                                                                                            | Cost                |

## (d) Structure and data model

### Repository layout (Phase 0 creates only these)

```
/
├─ package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
├─ eslint.config.mjs · .prettierrc.json · .editorconfig · .nvmrc · .npmrc · .gitignore
├─ .env.example                      placeholders only (rule 5)
├─ docker-compose.yml                postgres:17 + redis:7 for local dev
├─ lefthook.yml · .gitleaks.toml     pre-commit secret scan (skips with a warning if gitleaks isn't installed; CI is authoritative)
├─ .github/workflows/ci.yml · .github/dependabot.yml
├─ README.md                         quickstart
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/                    forward-only SQL (see data model below)
│  └─ rollbacks/                     one tested *.down.sql per migration
├─ docs/  ARCHITECTURE.md · DATA_SOURCES.md · DECISIONS.md · RUNBOOK.md · COMPLIANCE.md
│         BRIEF.md · plans/PHASE_0_PLAN.md · plans/PHASE_0_REPORT.md (end of phase)
├─ packages/
│  ├─ config/        src/env.ts (zod schemas per app, secret redaction), shared tsconfig/eslint presets
│  ├─ db/            src/client.ts (Kysely + pg), src/types.generated.ts, test-support/supabase-shim.sql,
│  │                 scripts/migrate.ts · rollback.ts · codegen.ts, test/ (RLS + constraint tests)
│  ├─ calendar/      src/{holidays,early-closes,special-closures,sessions}.ts, test/fixtures/nyse-published.json
│  ├─ market-data/   src/types.ts (canonical zod types + provenance), src/provider.ts (interface, errors),
│  │                 src/licenses.ts (data_licenses, attribution, enforceDelay), src/routing.ts (routing + failover),
│  │                 src/http.ts (host allowlist, timeouts, backoff+jitter, redaction),
│  │                 src/rate-limit/redis-token-bucket.{ts,lua}, src/validation.ts, src/adjustments.ts,
│  │                 src/adapters/{tiingo,sec-edgar,fred,synthetic}.ts, test/ + test/fixtures/{tiingo,sec-edgar,fred}/
│  └─ compliance/    src/SampleDataBanner.tsx, src/copy.ts (copy registry; grows in Phase 1)
└─ apps/
   ├─ worker/        src/{main,queues,scheduler,freshness,log,cli}.ts,
   │                 src/jobs/{ingest-securities,ingest-eod,reconcile-eod,recompute-adjustments,
   │                           ingest-fundamentals,ingest-filings,ingest-macro,ensure-partitions,staleness-monitor}.ts,
   │                 src/repo/*.ts (all DB writes), test/
   └─ web/           Next.js 16: src/proxy.ts (Basic auth + X-Robots-Tag), src/app/admin/data-health/page.tsx,
                     src/server/health.ts (read-only ops queries), test/
```

The `/fixtures` convention from rule 6 is satisfied by each package's `test/fixtures/` plus the `TEST_` ticker prefix. `packages/indicators`, `backtest` and `ui`, and `/infra`, arrive in later phases.

### Environment variables (`.env.example`, placeholders only)

`APP_ENV` (local|test|preview|staging|production) · `LOG_LEVEL` · `DATABASE_URL` · `REDIS_URL` · `APP_NAME` · `SEC_CONTACT_EMAIL` · `FRED_API_KEY` · `DATA_PROVIDER_PRIMARY` · `DATA_PROVIDER_FALLBACK` · `TIINGO_API_KEY` · `ADMIN_BASIC_AUTH_USER` · `ADMIN_BASIC_AUTH_PASSWORD`

The env schema **refuses to start** in the following cases:

- the `synthetic` provider is enabled while `APP_ENV=production`, so sample data can never pass for real (MUST-NOT #2);
- SEC ingestion is enabled without a contact email.

### Data model: Phase 0 migrations, with refinements to §4

| Migration                      | Contents                                                                                                                                                                           | Refinements vs §4 (need your OK, question 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `…_schemas_roles`              | `market` and `ops` schemas; `btree_gist`; revoke all on both schemas from `anon`, `authenticated` and `public`                                                                     | New: non-exposed schemas (assumption 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `…_securities`                 | `market.securities`, `market.security_symbol_history`, `market.provider_symbols`                                                                                                   | `security_id` is `bigint identity`, half the size of a uuid across more than 1M price rows. An **exclusion constraint** means one ticker can't point to two securities at once, while reuse after a delisting still works. New `provider_symbols` maps vendor spellings (`BRK-B` vs `BRK.B`). `asset_class` is text with a CHECK constraint, so crypto/FX/futures can be added later.                                                                                                                 |
| `…_prices_daily`               | `market.prices_daily`, `PARTITION BY RANGE(date)`: one partition for pre-2000, yearly partitions 2000–2028, and a `DEFAULT`; function `market.ensure_prices_daily_partition(year)` | Prices are stored as `numeric`, volume as `bigint`. New `ingestion_run_id`. CHECK constraints (low ≤ open/close ≤ high, volume ≥ 0) back up the ingest validator. PK stays `(security_id, date, source)`.                                                                                                                                                                                                                                                                                             |
| `…_corporate_actions`          | `market.corporate_actions`, `market.adjustment_factors`, view `market.prices_daily_adjusted`                                                                                       | Actions gain `id`, `record_date`, `pay_date`, `details jsonb` (for spin-off target or old/new ticker) and a unique key `(security_id, type, ex_date, source)`. **`adjustment_factors` is sparse:** one row per ex-date holding the cumulative split and dividend factors for all bars before it. That is a step function, not one row per bar. The view joins each raw bar to the next ex-date after it. Raw bars are never modified.                                                                 |
| `…_fundamentals_filings_macro` | `market.fundamentals_facts`, `market.filings`, `market.macro_series`, `market.macro_observations`                                                                                  | **Facts are keyed by CIK, and `security_id` is dropped.** One CIK can cover several share classes (e.g., GOOG/GOOGL), so the join goes through `securities.cik`. Facts gain `frame` and a unique key `(accession_no, taxonomy, concept, unit, period_start, period_end)`. Every filing's version of a fact is kept, which later backtests need for point-in-time `filed_at`. Filings gain `primary_document` and `items text[]`. New macro tables: FRED's `"."` becomes `NULL` (missing), never zero. |
| `…_ops`                        | `ops.data_ingestion_runs`, `ops.data_corrections`, `ops.provider_health`, `ops.data_quality_issues`, `ops.alerts`                                                                  | New `data_quality_issues` holds rejected or flagged bars with the rule name and raw payload. New `ops.alerts` has a partial unique index, so only one open alert exists per (kind, dataset, provider).                                                                                                                                                                                                                                                                                                |

**Adjustment math**, documented in `ARCHITECTURE.md` and unit-tested.

- A split with ratio _r_ multiplies prior prices by 1/_r_ and prior volume by _r_. Examples: 4:1 means _r_ = 4; 1:10 reverse means _r_ = 0.1; a _k_% stock dividend means _r_ = 1 + _k_/100.
- A cash dividend _D_ multiplies prior prices by (1 − _D_/_C_), where _C_ is the **raw** close on the prior trading day.
- If _C_ is missing, or _D_ ≥ _C_, the dividend is flagged in `data_quality_issues` and not applied. Nothing is estimated.

**RLS scaffolding.** RLS is enabled on every table in `market`, `ops` and `public`, and grants are revoked from the client roles. A test fails CI if any table lacks RLS, or if `anon`/`authenticated` can use `market` or `ops`. A `withRole(role, claims)` test helper is ready for Phase 1's per-user policies.

**Not in Phase 0:** `prices_intraday_1m` (Phase 1, once intraday is shown), `financial_statements` (Phase 1 viewer), insiders/13F/news/earnings (Phase 1–2), and all user, billing and AI tables (Phase 1+).

## (e) Step list (each step can be verified in under 30 minutes)

Each step ends with a commit, a passing test run and a one-line "how I verified this" note in the commit body.

| #   | Step                                                                                                                                                                                                    | Verification                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monorepo skeleton: pnpm workspaces, Turborepo, TS/ESLint/Prettier presets, `.nvmrc`, README                                                                                                             | `pnpm i --frozen-lockfile && pnpm turbo typecheck lint` green                                                                                                    |
| 2   | `packages/config` env module + `.env.example`                                                                                                                                                           | Unit tests: missing or invalid vars fail with clear errors; secrets are redacted from errors and logs; the synthetic-in-production guard works                   |
| 3   | CI workflow: install, format, lint, typecheck, unit; gitleaks (binary, not the licensed action); `pnpm audit --prod`; license check (block GPL/AGPL in web deps); Dependabot                            | Workflow is green on the pushed branch (checked through the GitHub API)                                                                                          |
| 4   | Local infra: `docker-compose.yml`, Supabase shim, migrate/rollback scripts, lefthook                                                                                                                    | Empty DB → migrate → rollback → migrate completes cleanly                                                                                                        |
| 5   | Migration: schemas, extensions, grants                                                                                                                                                                  | CI runs the up/down/up round trip                                                                                                                                |
| 6   | Migration: securities, symbol history, provider symbols                                                                                                                                                 | Tests: overlapping ticker ranges are rejected; non-overlapping reuse is accepted                                                                                 |
| 7   | Migration: partitioned `prices_daily` + partition function                                                                                                                                              | Tests: rows route to the right partition; `EXPLAIN` shows pruning; out-of-range rows land in `DEFAULT` and are detected                                          |
| 8   | Migration: corporate actions, adjustment factors, adjusted view                                                                                                                                         | Round trip + view returns raw × factors for a hand-built case                                                                                                    |
| 9   | Migration: fundamentals facts, filings, macro                                                                                                                                                           | Round trip + unique-key tests                                                                                                                                    |
| 10  | Migration: ops tables                                                                                                                                                                                   | Test: a second open alert for the same key is rejected; a new one is allowed after resolution                                                                    |
| 11  | RLS and privilege test suite                                                                                                                                                                            | Test fails on a temp table without RLS (proves the guard works); passes on the real schema                                                                       |
| 12  | Kysely codegen + db client + CI drift check                                                                                                                                                             | Regenerating types in CI produces an empty diff                                                                                                                  |
| 13  | `packages/calendar`: holidays, observance rules, 1:00 pm early closes, special closures (e.g., 2018-12-05, 2025-01-09), UTC sessions                                                                    | Tests against NYSE's published holiday and early-close lists, DST switch days and historical closures                                                            |
| 14  | Canonical types + `MarketDataProvider` interface. Phase 0 implements securities, daily bars, corporate actions, fundamentals and filings; the other methods throw `NotSupportedError`                   | Schema and type tests; every record requires `source`, `source_symbol`, `fetched_at`, `as_of` and `license_tier`                                                 |
| 15  | `licenses.ts` (`data_licenses`, attribution registry, `enforceDelay`)                                                                                                                                   | Unit test: intraday data newer than now − delay is dropped for non-entitled users; attribution exists for every enabled provider                                 |
| 16  | `http.ts`: host allowlist (SSRF), timeouts, retries with backoff and jitter on 429/5xx (403/503 too for SEC), gzip, never logs keys                                                                     | Tests against a local mock server: retry counts and timing; a non-allowlisted host is refused; logs contain no key                                               |
| 17  | Global SEC rate limiter: Redis token bucket via atomic Lua, 8 req/s shared by all processes; **fails closed** if Redis is down; enforces the User-Agent                                                 | Integration test with real Redis: 3 concurrent clients over 5s make ≤ 8 requests in any 1s window; if Redis is unreachable, zero requests are made               |
| 18  | SEC EDGAR adapter: ticker↔CIK map, submissions, companyfacts                                                                                                                                            | Recorded-fixture tests: units (USD, shares, USD/shares), the same fact across multiple filings, 10-digit CIK padding                                             |
| 19  | FRED adapter: series metadata + observations                                                                                                                                                            | Fixture tests: `"."` becomes null; `api_key` never appears in logs or errors                                                                                     |
| 20  | Primary adapter (Tiingo by default): securities, raw daily bars, splits/dividends from `splitFactor`/`divCash`                                                                                          | Tests against vendor-shaped synthetic fixtures; flagged "shape unverified" in `DATA_SOURCES.md`                                                                  |
| 21  | Synthetic provider: seeded 500 × 10-year universe + scenario catalogue (assumption 6)                                                                                                                   | Determinism: same seed gives an identical hash. Every scenario is present. Every record is `TEST_`-prefixed and has `source = 'synthetic'`.                      |
| 22  | Validation rules (pure functions)                                                                                                                                                                       | Table-driven tests: bad OHLC or negative volume → reject; >50% move with no action → flag; duplicates within a batch → reject                                    |
| 23  | Adjustment engine (pure functions)                                                                                                                                                                      | Hand-computed expected series for 4:1, 20:1, 1:10 reverse, cash, special and stock dividends; the raw input is never changed                                     |
| 24  | Worker skeleton: BullMQ queues, deterministic job IDs (`ingest-eod:2026-09-29:TEST_AAA`), retries with backoff and jitter, dead-letter queue, pino logs, graceful shutdown                              | Integration test: enqueuing the same job twice runs it once; a job that always fails lands in the dead-letter queue                                              |
| 25  | `ingest-securities` + `ingest-eod`: fetch → validate → COPY into staging → set-based merge. Unchanged rows are no-ops; changed rows are updated and logged in `data_corrections`. Each run is recorded. | Ingest the 500 × 10y universe **twice**: the second run inserts 0 rows, the row count is identical, and `DEFAULT` is empty                                       |
| 26  | `reconcile-eod`: re-ingest the last N days nightly                                                                                                                                                      | Test: a changed upstream bar → one `data_corrections` row with old and new values                                                                                |
| 27  | `recompute-adjustments`, triggered by a new corporate action                                                                                                                                            | Test: adding a split changes the adjusted view output; the raw row checksums are unchanged                                                                       |
| 28  | `ingest-fundamentals` (companyfacts) + `ingest-filings` (submissions metadata) through the limiter. The bulk-zip path is written up in the RUNBOOK and deferred to Phase 1.                             | Fixture-driven integration test; CLI command ready for the live 50-company run                                                                                   |
| 29  | `ingest-macro` (FRED)                                                                                                                                                                                   | Integration test on fixtures                                                                                                                                     |
| 30  | Calendar-driven scheduler: EOD after close (including early closes), nightly reconcile, off-peak EDGAR, monthly `ensure-partitions`                                                                     | Fake-clock tests across a holiday, an early close and both DST switches                                                                                          |
| 31  | Freshness SLOs + staleness monitor (every minute) + `provider_health` + routing/failover (`provider_failover` event, then fallback or "last-good + stale banner")                                       | **Simulated outage:** fake clock at 18:31 ET on a trading day, primary stub failing → alert opens, failover event fires, and the alert auto-resolves on recovery |
| 32  | Admin data-health page. Per dataset it shows freshness, last run, open alerts, quality-issue counts and `DEFAULT`-partition rows. It shows a SAMPLE DATA banner outside production.                     | Tests: 401 without credentials, 200 with them; `noindex` header present; the page's queries touch only `ops.*` and counts                                        |
| 33  | Docs: ARCHITECTURE, DATA_SOURCES, DECISIONS (ADRs covering the choices in (c)), RUNBOOK (re-ingest, partitions, rate limits, outage), COMPLIANCE                                                        | Reviewed against §2.2, §10 and §13                                                                                                                               |
| 34  | Phase 0 acceptance run + §14 deliverables → `docs/plans/PHASE_0_REPORT.md`                                                                                                                              | See the table below                                                                                                                                              |

### Acceptance criteria mapping

| Phase 0 criterion                                            | How it's proven                                                                                                    | Needs from you                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 10 years of daily bars for 500 tickers ingest idempotently   | Step 25 integration test + CLI demo (run twice; the second run inserts 0 rows; the PK makes duplicates impossible) | —                                      |
| Split fixtures produce correct adjusted series               | Steps 23 and 27 (4:1, 20:1, 1:10, dividend cases)                                                                  | —                                      |
| EDGAR companyfacts for 50 companies without a single 403/429 | Live CLI run at 8 req/s; the run record counts responses by status                                                 | **Brand + contact email** (question 1) |
| Staleness alerts fire in a simulated outage                  | Step 31 test + demo script                                                                                         | —                                      |
| CI is green                                                  | GitHub Actions on this branch                                                                                      | Actions enabled on the repo            |

**Cost snapshot:** $0. Local services and GitHub Actions free minutes; EDGAR and FRED are free (a FRED API key is free and needed for the live macro run). No vendor contract is required until real data is shown to anyone other than you.

**Estimated effort:** 34 small steps. At the pace in Part F, this is the 2–4-week Phase 0 window of solo work with an AI agent.
