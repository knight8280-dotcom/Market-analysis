# Decisions (ADR log)

Each entry: context, decision, alternatives rejected, consequences. Newest last. ADR-001 to ADR-008 were approved with the Phase 0 plan on 2026-09-30; the rest were made during Phase 0 and are reported in `plans/PHASE_0_REPORT.md`.

## ADR-001: pnpm + Turborepo monorepo, TypeScript 6.0, Node 24

- **Decision:**
  - pnpm 10 workspaces with Turborepo 2 (spec §10).
  - TypeScript is pinned to **6.0.x**. TS 7.0 is npm's `latest`, but typescript-eslint 8.71 supports only `<6.1.0`.
  - Node 24 LTS in CI and `.nvmrc`; code must also run on 22.12+ (22 reaches end-of-life in April 2027).
- **Alternatives rejected:** TS 7 without type-aware linting. Type-aware rules catch floating promises, which matter in a job runner.
- **Consequences:** move to TS 7 once typescript-eslint supports it. Internal packages export `.ts` source, with no build step between packages.

## ADR-002: Supabase-native migrations with tested rollback scripts; Kysely with generated types

- **Decision:**
  - Forward-only SQL in `supabase/migrations`. This is the Supabase CLI layout and works with preview branching.
  - Each migration has `supabase/rollbacks/<version>_<name>.down.sql`.
  - A small runner (`packages/db/src/migrations.ts`) applies both locally and in CI, writing to the CLI's history table, `supabase_migrations.schema_migrations`.
  - `pnpm db:roundtrip` proves, for every k, that rolling back k migrations and re-applying them restores an identical schema fingerprint.
  - Queries use Kysely, with types generated from a freshly migrated database (`kysely-codegen`). CI fails on drift (`db:codegen:check`).
  - Production applies migrations with `supabase db push`.
- **Alternatives rejected:**
  - Drizzle: its generator cannot express partitioned tables, RLS or exclusion constraints, so we would hand-write SQL and keep a second schema in sync by hand.
  - dbmate: an extra binary, and Supabase branching would not see its migrations.
- **Consequences:** our history table uses the CLI's three columns (`version`, `statements`, `name`). Confirm compatibility with `supabase migration list` on the first real project (known issue).

## ADR-003: Market and ops data in non-exposed schemas; RLS everywhere; security audit in CI

- **Decision:**
  - Licensed and operational tables live in `market` and `ops`, which are not API-exposed, and client roles get no `USAGE` on either.
  - RLS is enabled on every table and partition.
  - `auditDatabaseSecurity()` fails CI on any table without RLS, any client grant on a private schema, or any function client roles could execute.
- **Why:** Supabase auto-exposes `public` through its REST API. One forgotten table would let anyone with the anon key read licensed prices (MUST-NOT #4, the license, §8 scraping).
- **Found in practice:** a per-schema `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE` cannot revoke PUBLIC's global default, so every function revokes `EXECUTE` explicitly. The audit caught this.

## ADR-004: Native yearly partitions for prices_daily, no pg_partman

- **Decision:**
  - Pre-created partitions (pre-2000, 2000–2028) plus a `DEFAULT` partition.
  - `market.ensure_prices_daily_partition(year)` is called by the daily `ensure-partitions` job for this year and next.
  - The monitor alerts if `DEFAULT` holds rows.
- **Why:** stock `postgres:17` (local and CI) has no pg_partman, and yearly partitions need no automation beyond one idempotent function. Local, CI and production stay identical.
- **Deviation from spec §3.2** ("managed with pg_partman"); approved with the plan. Revisit for monthly intraday partitions in Phase 1.

## ADR-005: Fundamentals keyed by CIK; filings keyed by (accession, CIK)

- **Decision:**
  - `fundamentals_facts` has no `security_id`. One registrant (CIK) can list several share classes, so joins go through `securities.cik`.
  - Every filing's copy of a fact is kept, which point-in-time backtests need.
  - The unique key uses `NULLS NOT DISTINCT`, because instant facts have a NULL `period_start`; without it, re-ingests would duplicate them.
  - Filings are keyed by `(accession_no, cik)`, because co-registrants share accession numbers.

## ADR-006: Sliding-window-log rate limiter for SEC, failing closed

- **Decision:**
  - A Redis sorted-set log with atomic Lua, using Redis `TIME`.
  - It guarantees at most 8 grants in any 1-second window across all processes.
  - If Redis is unreachable, the request is not sent.
- **Alternatives rejected:** a token bucket, as named in the plan. A bucket allows up to twice the rate across a window edge, which could exceed SEC's 10/s. The integration test checks the window property directly.

## ADR-007: Integration tests on service containers with template databases

- **Decision:**
  - CI runs `postgres:17` and `redis:7` as GitHub Actions services.
  - Each test package's global setup builds a migrated template database, and each test file clones it with `CREATE DATABASE … TEMPLATE` in milliseconds.
- **Alternatives rejected:** Testcontainers. It gives the same isolation but needs a Docker daemon, which the development sandbox lacks.

## ADR-008: Basic auth for the Phase 0 admin page (superseded by ADR-018)

- **Decision:**
  - `apps/web/src/proxy.ts` (Next 16's renamed middleware, Node runtime) guards `/admin/*` with HTTP Basic auth from env.
  - It compares SHA-256 digests with `timingSafeEqual` and returns 503 if credentials are not configured.
  - Admin responses are sent with `X-Robots-Tag: noindex` and `Cache-Control: no-store`.
  - The page selects metadata only.
- **Consequences:** replaced by Supabase Auth with an admin role and TOTP in Phase 1 (spec §7).

## ADR-009: Approve libvips (LGPL-3.0) via sharp

- **Context:** the license check blocks copyleft licenses in production dependencies (§8). Next.js pulls in `sharp` as an optional dependency, and sharp ships `@img/sharp-libvips-*` (LGPL-3.0-or-later).
- **Decision:** approve those packages in `scripts/check-licenses.mjs`. libvips runs server-side only, is dynamically linked, and is never shipped to browsers, which LGPL permits.
- **Revisit** if we ever distribute binaries to users, or if image optimization is turned off. Setting `images.unoptimized` would let us drop sharp.

## ADR-010: BullMQ job ids use "/" separators

- **Context:** BullMQ 6 rejects custom job ids containing `:` unless they have exactly three `:`-separated parts (legacy repeatable-job ids).
- **Decision:** ids are built by `jobId()` as `name/part/part` (e.g. `ingest-eod/2026-09-29/TEST_S001`), and colons are refused. The spec's example uses `:`; only the separator differs.

## ADR-011: Failover refinements

- **Decision:**
  1. Failback needs 3 healthy probes counted **from the failover**. The primary's success count resets when a dataset fails over.
  2. A staleness breach reroutes only if a fallback exists. With no fallback the data is stale either way, so the alert and banner carry the message.
  3. Repeated provider errors (3 consecutive) still route to "none": jobs fail fast, and readers serve last-good data.
- **Found in practice:** running the monitor against the local 500-ticker database made it fail over to "none" and back in the same tick. The regression test fails without fix 1.

## ADR-012: EDGAR acceptanceDateTime is UTC (supersedes the Eastern-time assumption)

- **Original decision (unverified):** read the wall-clock part of `acceptanceDateTime` as Eastern, as the conservative choice for point-in-time data.
- **Verified 2026-09-30 on the live run:** the value is true UTC. Apple's FY2025 10-K has `2025-10-31T10:01:26.000Z` in the JSON and "Accepted 2025-10-31 06:01:26" (Eastern) on its index page.
- **Decision:** parse it as ISO UTC, falling back to 00:00 ET on the filing date when it is missing or malformed.
- **Filings self-heal:** re-ingesting updates stored rows whose parsed metadata differs, so the 4–5h error is corrected without a migration.

## ADR-013: Stored numeric precision and driver parsing

- **Decision:**
  - Prices are `numeric(20,6)`, volume `bigint`, adjustment factors `double precision`.
  - The pg driver returns `numeric` and `bigint` as strings (matching the generated types) and `date` as `YYYY-MM-DD` strings. pg's default Date parser shifts dates by the process time zone.
  - Merges compare values as `numeric(20,6)`, so re-ingesting the same vendor values is a no-op.

## ADR-014: Dependencies

Spec rule 8 requires each dependency's license, maintenance status and bundle impact. All versions are pinned exactly (`.npmrc save-exact`), and Dependabot proposes updates weekly. "Maintained" means actively released as of 2026-09.

| Package                                                | Version                          | License    | Where                       | Why / bundle impact                                                                                                                       |
| ------------------------------------------------------ | -------------------------------- | ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| zod                                                    | 4.6.5                            | MIT        | config, market-data, worker | env and vendor-payload validation (spec §0 rule 5, §2.1). Server-only in Phase 0                                                          |
| kysely                                                 | 0.29.6                           | MIT        | db                          | typed SQL builder, no runtime ORM magic. Server-only                                                                                      |
| pg                                                     | 8.23.0                           | MIT        | db                          | standard Postgres driver. Server-only                                                                                                     |
| ioredis                                                | 6.0.0                            | MIT        | market-data, worker         | Redis client for BullMQ and the rate limiter. Worker only                                                                                 |
| bullmq                                                 | 6.3.10                           | MIT        | worker                      | job queues with retries, backoff with jitter, idempotent ids (spec §3.4). Worker only                                                     |
| pino                                                   | 10.3.1                           | MIT        | worker                      | structured JSON logs with redaction (spec §10). Worker only                                                                               |
| next                                                   | 16.3.7                           | MIT        | web                         | App Router framework (spec §3.1). Phase 0 page ships no client component of ours                                                          |
| react, react-dom                                       | 19.3.0                           | MIT        | web, compliance             | required by Next                                                                                                                          |
| server-only                                            | 0.0.1                            | MIT        | web                         | build error if server modules leak into client bundles. No runtime cost                                                                   |
| typescript                                             | 6.0.3                            | Apache-2.0 | dev                         | ADR-001                                                                                                                                   |
| eslint, @eslint/js, typescript-eslint, globals         | 10.11.0, 10.0.1, 8.71.0, 17.12.0 | MIT        | dev                         | type-aware linting (floating promises, unsafe any)                                                                                        |
| prettier                                               | 3.9.9                            | MIT        | dev                         | formatting                                                                                                                                |
| vitest                                                 | 5.0.2                            | MIT        | dev                         | unit, integration and acceptance tests                                                                                                    |
| tsx                                                    | 4.23.15                          | MIT        | dev and worker runtime      | runs TypeScript directly (CLI, worker start, scripts). A bundled production build of the worker is decided with the Phase 1 deploy target |
| turbo                                                  | 2.11.5                           | MIT        | dev                         | task runner and cache                                                                                                                     |
| kysely-codegen                                         | 0.20.0                           | MIT        | dev                         | types from the migrated schema (ADR-002)                                                                                                  |
| lefthook                                               | 2.1.15                           | MIT        | dev                         | pre-commit secret scan and format check                                                                                                   |
| @types/node, @types/pg, @types/react, @types/react-dom | 24.19.0, 8.23.1, 19.3.0, 19.3.0  | MIT        | dev                         | typings                                                                                                                                   |

CI also uses `gitleaks/gitleaks-action@v3`, which is free for personal-account repositories. An organization owner would need a `GITLEAKS_LICENSE`, or would switch to running the gitleaks binary directly.

## ADR-015: Personal use only

- **Context:** the brief describes a public, commercial site. On 2026-09-30 the owner decided the system is for personal use only.
- **Decision:**
  - Personal data plans are sufficient. The system never shows data to anyone else, and never on a public URL.
  - Drop items that exist only for a public or commercial site: SEO pages and sitemaps, Stripe billing and tiers, public legal pages, cookie consent, marketing-copy rules, vendor display contracts and exchange subscriber attestation.
  - Keep every MUST DO / MUST NOT rule, source and as-of labels, and the SAMPLE DATA banner.
  - Run locally by default. A private cloud deploy is optional and needs Supabase Auth.
- **Consequences:** if the system is ever shared or published, the licensing work in `DATA_SOURCES.md` and the dropped items come back first. Phase 1 is re-planned in `plans/PHASE_1_PLAN.md`.

## ADR-016: Sectors from SEC SIC codes, not GICS

- **Context:** the heatmap, screener and ticker page group securities by sector. GICS is licensed by MSCI and S&P; Tiingo's free plan reports no sector.
- **Decision:** take each registrant's SIC code from EDGAR submissions (public domain) and map it to 11 GICS-like groups with `sectorForSic` (`packages/market-data/src/sectors.ts`), first matching range wins. `industry` holds SEC's SIC description. Securities without a CIK (ETFs, funds) keep a null sector.
- **Consequences:** groups are close to, not equal to, GICS (for example Alphabet and Meta fall under Technology through SIC 7370, where GICS puts them in Communication Services). The UI labels them "Sector (SEC SIC)". A vendor that reports its own sector overwrites it; none of the configured vendors does today.

## ADR-017: A committed universe file, paced by the vendor's quota

- **Context:** Tiingo's free plan allows 500 unique symbols a month and 50 requests an hour, and its meta endpoint does not report the asset class.
- **Decision:** the worker loads exactly the symbols in `config/universe.json` (65 today: 50 large caps and 15 ETFs), each with its asset class. Tiingo requests pass through hourly and daily Redis sliding windows (ADR-006's limiter, composed); jobs wait for a slot rather than fail. The synthetic provider ignores the file.
- **Consequences:** adding a symbol is a one-line change plus `pnpm worker bootstrap` (idempotent). A larger universe needs a paid personal plan and the two limit variables.

## ADR-018: Owner password login with a signed session cookie (supersedes ADR-008)

- **Context:** Phase 1 turns the admin page into an app with personal-plan data on every page (ADR-015). It runs locally for one person; Supabase Auth is only needed for the optional cloud deploy.
- **Decision:**
  - One owner password, stored only as a scrypt hash (N = 2^17, r = 8, p = 1) in `OWNER_PASSWORD_HASH`; `pnpm web:hash-password` prints it. The format uses ":" separators because `.env` loaders expand "$".
  - Sign-in is a Server Action (same-origin checked by Next). Success sets an httpOnly, SameSite=Lax cookie holding an HMAC-SHA256-signed token (14 days). The key is derived from `SESSION_SECRET` and the password hash, so changing either ends every session.
  - `proxy.ts` guards every route except `/login` and `robots.txt`; pages and API routes check the session again (`requireOwner`, `ownerOr401`). Missing configuration fails closed (503).
  - Only loopback host names (plus `WEB_ALLOWED_HOSTS`) are served, against DNS rebinding; `pnpm web` binds to 127.0.0.1.
  - Failed sign-ins are throttled globally: 10 per 15 minutes.
- **Consequences:** no user table, no password reset by email (re-run the hash command). A cloud deploy or a second user replaces this with Supabase Auth (Phase 1 group L), keeping the proxy and `requireOwner` call sites.

## ADR-019: Indicators follow TA-Lib's conventions, checked against TA-Lib output

- **Context:** indicator values differ between libraries in small, visible ways (EMA seeding, Wilder smoothing, warm-up length, population vs sample deviation). The plan requires matching a reference within 1e-6.
- **Decision:** `packages/indicators` reproduces TA-Lib 0.8 exactly, quirks included: EMAs seeded with an SMA; MACD's fast EMA seeded at the slow EMA's first index, with all three lines starting at index 33 (12/26/9); RSI, ATR and DI with Wilder smoothing from a simple-average seed; Bollinger with population deviation; slow %K and %D starting together; OBV starting at the first volume; flat input giving 0 (RSI, %R, CCI, DI). Indicators TA-Lib lacks (rolling VWAP, Donchian, Keltner, annualized volatility, relative strength) are checked against plain NumPy/pandas formulas. `scripts/make_fixtures.py` regenerates the fixtures from a seeded synthetic walk.
- **Consequences:** charts agree with most trading platforms. The worst difference seen is about 4e-12. Changing a convention means regenerating the fixtures and noting it here.

## ADR-020: Financial statements from companyfacts, keyed by period dates, with two bases

- **Context:** statements must be exact and traceable, show restatements, and never invent values (MUST-NOT #1). A fact's `fy`/`fp` in companyfacts describe the filing it came from, not the fact's period: a 10-K repeats the prior year as a comparative tagged with the new fiscal year.
- **Decision:**
  - Reporting periods come from each filing's own period: the latest ~1-year span in a 10-K and the latest ~3-month span in a 10-Q, labelled with that filing's fiscal year and period. Q4 is the rest of the fiscal year after Q3.
  - Each line has an ordered list of us-gaap concepts; per period the first concept with a value wins and is stored with the value (plus unit, accession and filing date). USD, USD/shares and shares only.
  - Two bases: `latest` (most recent filing reporting that exact period, so restatements apply) and `as_reported` (earliest). A statement row is flagged `restated` when they differ.
  - Quarterly flows missing for the quarter itself are derived from year-to-date values with the same concept (Q2 = 6M − 3M, Q3 = 9M − 6M, Q4 = FY − 9M), in exact decimal arithmetic, and marked derived; per-share values and weighted share counts are never derived. Free cash flow (operations − capex) is the only derived line and is labelled so.
  - Built by the `build-statements` job after each companyfacts load; stored in `market.financial_statements`.
- **Checked:** against SEC's own rendering of each filing (the R pages from `FilingSummary.xml`, whose rows and columns come from the filing's presentation linkbase, which the builder never reads). 2026-09-30, 10 companies' latest 10-Ks: 301 values compared, all equal to the dollar (28 of them presented negated by SEC, e.g. capex), 0 mismatches; 40 requests, all HTTP 200.
- **Consequences:** values a filer tags only with a company-specific or dimensioned concept stay blank rather than estimated (for example Wells Fargo revenue in some years; Visa and Alphabet diluted EPS, which are reported per share class). The first filing in companyfacts limits how far back periods go (usually 2009).

## ADR-021: Screener over a nightly snapshot, with a whitelisted filter compiler

- **Context:** the screener must answer any combination of filters over the whole universe in under a second (p95 at 6,000 securities) and never let user input reach SQL as code.
- **Decision:**
  - `refresh-screener` rebuilds `market.screener_snapshot` after the 18:30 end-of-day deadline (scheduled 18:45 ET): latest close, total returns over calendar windows from adjusted closes, SMA 50/200 and RSI 14 (TA-Lib conventions, ADR-019), 52-week range, 30-day volume, market cap (latest cover-page shares × close), TTM P/E, P/S, P/B and dividend yield. A return whose start falls in a gap in the data is left empty; ratios are empty unless the inputs are positive and reported.
  - A screen is JSON (`@market/screener` schema): AND-ed conditions on whitelisted fields (constants, ranges, lists, null checks, or another numeric field) and a sort. The compiler emits identifiers only from the whitelist and binds every value. NULL never satisfies a comparison.
  - An independent in-memory oracle evaluates the same screens; 300 random screens and every preset must match the SQL results and order exactly.
  - Saved screens live in `public.saved_screens` (migration 10), per user, under RLS.
- **Measured:** p95 10.9 ms over 47 screens at 6,000 synthetic securities (budget 1 s).
- **Consequences:** results are as fresh as the last snapshot (shown with its as-of date). Presets are filters, not recommendations (spec §13). Migration order changed from the plan: 10 is now the per-user tables (needed for saved screens), 11 the earnings and economic calendars.

## ADR-022: Alerts on end-of-day crossings, fired once, delivered separately

- **Context:** alerts must fire at most once per crossing (plan I2), never flood the owner's inbox, and survive retries and email outages without duplicates. Data is end-of-day only (ADR-015), so intraday triggers are out of scope.
- **Decision:**
  - Conditions (`@market/alerts`, shared by worker and web): close crosses above or below a level (the previous close at or on the other side of it, split-adjusted to the latest bar's basis); one-day move of at least N% up, down or either (split-adjusted); an earnings date within the next N days (Finnhub). Definitions are validated JSON in `public.alerts.params`.
  - `evaluate-alerts` runs at 18:50 ET (after the 18:30 end-of-day deadline and the screener) against the latest bar of the active price route. An event is unique per (alert, bar date), or per (alert, report date) for earnings, so a re-run fires nothing new. A per-alert cooldown (default 24 h) holds new crossings after a fire.
  - Firing and delivery are separate. Events start `pending`; delivery marks them `sent`, `failed` or `suppressed` (no email settings, a user other than the owner, or over `ALERT_DAILY_CAP`, default 20 per day). Failed sends make the job fail so the queue retries; Resend's `Idempotency-Key` (`alert-event-<id>`) stops a retry from sending a second copy.
  - Email goes only to `ALERT_EMAIL_TO`, the owner's own address, in plain text, with the data's as-of date and source, a SAMPLE DATA marker on synthetic data, and "not investment advice".
- **Consequences:** a price that gaps across a level between two runs still fires once (on the first bar past it). A day the worker misses is not re-evaluated; the next run looks at the latest bar only. Every event is listed on `/alerts` whether or not it was emailed.

## ADR-023: Portfolio returns from a replayed ledger, checked against a spreadsheet-style reference

- **Context:** portfolio figures must match a spreadsheet within 0.01% (plan J2), handle splits, and give sensible returns when the owner records only trades (no deposits).
- **Decision (`@market/portfolio`, pure TypeScript):**
  - The ledger is replayed day by day over the union of trading days, transaction dates and the end date, from the first transaction to the latest loaded session. Holdings are valued at raw end-of-day closes, carried forward over gaps; a security with no close yet is valued at cost, with a warning.
  - Lots are first-in, first-out. A split or stock dividend (from the price source's corporate actions) multiplies the quantity of lots opened before its ex-date and divides their cost per share, at the first day on or after the ex-date, before that day's trades. Buy fees go into cost; sell fees reduce proceeds.
  - Cash never goes negative: a shortfall at the end of a day is an implicit deposit (an external flow), so a trades-only ledger still has correct returns.
  - Time-weighted return chains daily returns with external flows at the start of the day: r = V_t / (V_{t−1} + F_t) − 1. Dividends and fees are part of the return, not flows. Annualized only over a year or more.
  - Money-weighted return is XIRR (actual/365), Newton's method with a bisection fallback; it matches the spreadsheet function's documented example to 1e-8.
  - The benchmark (default SPY) is its total-return index (split- and dividend-adjusted closes) over the same days.
  - Imports are all-or-nothing: every row is validated (the manual form uses the same rules), tickers must exist, and no sell may exceed the shares held at the time after splits.
- **Checked:** `scripts/make_fixture.py` computes the same scenario row by row the way a spreadsheet would (two made-up securities, a 2:1 split, FIFO sales across lots, a weekend dividend, implicit deposits, a withdrawal, fees) and writes `test/fixtures/expected.csv`. Every day's cash, value, flow and index and every summary figure match within 0.01%.
- **Consequences:** returns depend on the owner's entries; wrong trade prices or missing dividends show up directly in the figures. Taxes, currencies other than USD, options and short positions are out of scope.

## ADR-024: Feature flags as code defaults plus database overrides

- **Context:** the spec wants every Phase 2+ feature behind a flag (§10) and suggests a hosted flag service. For one owner running locally, a third-party service adds an account, a network dependency and data leaving the machine, for no benefit.
- **Decision:** flags are registered in code (`packages/config/src/flags.ts`) with a label, description and default; `ops.feature_flags` holds only the owner's overrides (server-only schema, RLS on). `/settings` turns features on or off and back to their default, audited. A feature that is off has no menu entry and its pages answer 404. A flag is registered when work on its feature starts and defaults to on once the feature is complete.
- **Consequences:** no new dependency or service; turning a feature off hides it but keeps its data. Flags are read once per request.

## ADR-025: Backtests on point-in-time data, run in a worker thread

- **Context:** spec §5.15 asks for a deterministic engine with realistic fills and costs, bias controls (point-in-time fundamentals, survivorship-free universes, adjusted prices for signals with split-aware share counts), validation (out-of-sample split, walk-forward, parameter sweeps with an overfitting warning) and reproducibility (code version and data snapshot). Two traps: an adjusted price history leaks the future (a later split rescales every earlier adjusted price), and a synchronous engine running a 400-combination sweep would block the worker for minutes.
- **Decision:**
  - `packages/backtest` is pure TypeScript. Indicators are computed once on the fully adjusted series, and every value read on session t is put back into session t's terms (price-unit values divided by that bar's adjustment factor, volume multiplied by its split factor), which equals computing them on the history as it was known then. Fills, valuations and share counts use raw prices. A test proves that a run up to any date is identical whether or not later data exists.
  - Rules are checked at each close; orders fill at the next session's open, never on the signal's own bar. Commission is a fixed amount per fill plus basis points of its value; slippage is basis points against each fill. Dividends are reinvested at the ex-date open without commission, or kept as cash; cash earns nothing (cash drag). Stops and take-profits fill at the open on a gap, else at their level (the stop first if both are touched). A delisted position closes at its last close. Long only, equal weight, optional ranking of candidates, optional weekly, monthly or quarterly rebalancing.
  - Fundamentals are used as first reported (as-reported statements and cover-page share counts) from the session after their filing. A listed ticker means the security that held it last within the period, with its whole history (renames keep their past; a reused ticker is noted). "All stocks" includes delisted securities until the day before they delisted.
  - Metrics use the shared definitions in `@market/metrics` (ADR-026): CAGR on 365.25-day years, Sharpe and Sortino against FRED DTB3 and unavailable without it. They and the buy-and-hold curves are checked against an independent Python script.
  - A run is a row in `public.backtest_runs` holding the whole request. The worker polls for queued runs every 3 seconds, enqueues `run-backtest/<id>` on the `backtest-run` queue (one at a time) and runs it in a worker thread: a 10-minute engine limit, then a hard stop a minute later. Results store the code version and a SHA-256 of the exact data read; re-running the same request on the same data reproduces the results and the fingerprint, and the report says so.
  - A sweep is capped at 400 combinations (warning above 20) and a walk-forward at 2,000 backtests. A sweep's best combination is labelled as picked with hindsight; the walk-forward's chained test windows are the out-of-sample record.
- **Consequences:** results live in Postgres JSONB rather than object storage (personal scale: a 10-year, 300-stock report is about 0.6 MB). Short selling, borrow costs, intraday bars and spin-off or merger modelling are out of scope; the report notes spin-offs and mergers it did not model. The worker thread loads TypeScript through `tsx/esm/api`, so `tsx` is a runtime dependency of the worker.

## ADR-026: One definition of each risk measure, shared by backtests and portfolios

- **Context:** Phase 2 adds portfolio risk (spec §5.10: volatility, Sharpe, Sortino, drawdown duration, beta and correlation against a benchmark, a correlation matrix of holdings, concentration, daily P&L) next to backtest reports that already compute most of these. Two implementations would drift, and the owner would see two different "Sharpe ratios".
- **Decision:** the series statistics move from `packages/backtest` into a new internal package, `@market/metrics` (pure TypeScript, no dependencies): daily returns, risk-free returns from FRED DTB3, volatility (sample standard deviation × √252), Sharpe, Sortino, drawdown and its duration, CAGR, monthly returns, plus beta, correlation (pairs where both returns exist; fewer than three pairs or no variation is "unavailable"), correlation matrices and concentration (top-10 share and Herfindahl index of holding weights, cash left out). The backtest package re-exports them unchanged.
  - Portfolio risk is measured on the time-weighted index at each market session, so deposits and withdrawals are never gains or losses; days that are not sessions (a weekend dividend) fold into the next session. Daily P&L is value less the previous value less that day's external flow, so the P&L adds up to value less money put in.
  - Holdings' correlations use a year of total-return (adjusted) closes and only closes on the day itself: carrying a stale close forward would add false zero returns, and raw closes would turn a split into a crash.
  - Each measure's method and the risk-free source are in a keyboard-reachable tooltip on the portfolio page.
  - Behind the `portfolio_risk` flag, on by default (registered at the Phase 2a acceptance check, which found the risk panel shipped without one). Off hides the risk panel and the allocation by asset class; returns, holdings and the sector allocation stay.
- **Consequences:** both pages agree by construction; the extended spreadsheet-style fixture (`packages/portfolio/scripts/make_fixture.py`) checks the portfolio figures within 0.01%, and the backtest fixture keeps checking the shared code. Annualizing the portfolio's time-weighted return stays on 365-day years, like XIRR (ADR-023).

## ADR-027: Valuation as a calculator over filed figures, with point-in-time history

- **Context:** spec §5.6 asks for a two-stage DCF with editable inputs, a WACC × terminal growth sensitivity table and saved scenarios, peer multiples with median, percentile and history, and the copy "This model is a calculator driven by your assumptions. It is not a price target or recommendation." Valuation outputs are the closest the app comes to advice, so where every number comes from must be visible, and nothing may be estimated.
- **Decision:**
  - `@market/valuation` is pure TypeScript and runs in the browser, so every edit recomputes at once (spec: within 100 ms; the E2E test measures it in the page). Conventions: stage-1 revenue growth with EBIT margin, tax, D&A and capex as shares of revenue and working capital as a share of revenue growth; end-of-year discounting; terminal value as a perpetuity on year N+1's cash flow (growth must stay below WACC) or an exit multiple of year N's EBITDA; equity = enterprise value − net debt. An independent Python script (`packages/valuation/scripts/make_fixture.py`) computes three scenarios row by row, spreadsheet style; the engine matches to 1e-10.
  - Inputs that come from filings (trailing-twelve-month revenue, EBIT margin, tax rate, D&A and capex shares, net debt as long-term debt less cash and short-term investments, diluted shares) start from the latest-basis statements and show their span and filing date; the rest (growth, WACC, terminal growth, working capital) are labelled as the owner's assumptions, with last year's growth shown for reference. A missing figure is left empty, never taken as zero.
  - Multiples (P/E, P/S, EV/EBITDA) are unavailable unless the denominator is positive. Peers share the SEC industry (SIC) code, else the industry name, and are the closest eight by market cap; the owner can list peers instead. The peer median and the company's percentile among them are descriptive.
  - The five-year history uses month-end closes against figures as first reported and known by each date (a figure counts from the day after its filing), with shares adjusted for later splits, so restatements add no hindsight.
  - Saved scenarios (`public.valuation_scenarios`, migration 14) store inputs only; outputs are recomputed on load.
  - The tab ships behind the `valuation` flag (on by default once complete).
- **Consequences:** results are only as good as the inputs and the filed data; the page says so beside every output. TTM lines are taken per line (a line reported only yearly still gets its fiscal-year figure), which can differ from the screener's joint rule when quarters omit a line; a test shows they agree when quarters report both.

## ADR-028: More alert conditions, checked as their data arrives

- **Context:** spec §5.14 adds indicator conditions, volume spikes, new SEC filings by form type and screen membership changes; evaluation on each data refresh, idempotent per alert and bar; delivery under 60 s after the data arrives; at most one alert per crossing; snooze or delete from the notification itself. Phase 1 (ADR-022) evaluated once a day at 18:50 and keyed events by bar date, which cannot hold two filings on one day or a screen's changing results.
- **Decision:**
  - Conditions (`@market/alerts`, pure): RSI crossing a level (Wilder smoothing on split- and dividend-adjusted closes, period 2 to 100); the close or a fast simple average crossing a slow one (adjusted closes); a session's volume at least N times the average of the previous sessions (split-adjusted); a new filing of chosen EDGAR form types, amendments optionally included; securities entering or leaving a saved screen. Level conditions fire once per crossing, daily events once per session.
  - Each event is unique per alert and `event_key`: the session or report date as before, the latest accession number for filings, or the snapshot date with a fingerprint of the screen's results. `bar_date` keeps the date of the data behind it.
  - An alert remembers (`public.alerts.state`) how far it has read through stored filings, by the time we stored them (so a filing that reaches EDGAR's feed late is still seen; it must have been accepted after the alert was created), and a screen's last reported results with a fingerprint of the screen's conditions (editing the screen restarts the comparison instead of reporting changes the edit caused).
  - Snooze (`snoozed_until`): a snoozed or cooling-down alert keeps filing and screen changes for later instead of dropping them; price and indicator crossings during a snooze are not replayed, since the next check looks at the latest bar.
  - Evaluation moves to its own queue, `alerts-evaluate` (spec §3.4's name), one job at a time so two runs never race over delivery or the daily cap. A run is queued as soon as an end-of-day load stores bars (the price-based alerts on those securities), a filings refresh stores filings (new-filing alerts on that registrant) or the screener is rebuilt (screen alerts), each with a job id naming the ingestion run; the 18:50 run still checks everything, including earnings dates. An integration test through real BullMQ queues measures about 0.1 s from queueing the end-of-day job to the email reaching a stand-in for Resend (limit 60 s).
  - Each new event gets an in-app notification (`public.notifications`, migration 15) in the same transaction while the `notifications` flag is on. Notification links lead only to a path in the app or to www.sec.gov, checked by the worker and by the table. Emails link to the alert's page at `APP_BASE_URL` to snooze, pause or delete it.
  - In the app: a bell in the header shows the unread count (refreshed every 30 seconds while the tab is visible, and as soon as notifications are read); `/notifications` lists them newest first and marks them read once shown; each one snoozes (1 day, 3 days or a week), pauses or deletes its alert where it stands, or is dismissed on its own. Each alert has its own page (`/alerts/<id>`), the target of the email link. Return paths after these actions are a fixed list, never a URL from the request.
  - The new kinds are behind the `alert_types` flag (while it is off they are neither offered nor evaluated) and the in-app part behind `notifications`; both default to on.
- **Consequences:** data stays end-of-day, so no intraday triggers. A screen with more than 5,000 results is compared on its first 5,000 by ticker. `insider_purchase` is reserved in the table for step H4, which brings the Form 4 data it needs.

## ADR-029: Chart drawings as a series primitive, kept to their price basis

- **Context:** spec §5.2 asks for trend lines, horizontal lines, Fibonacci retracements, rectangles and text on the chart, saved per user per security. Lightweight Charts has no drawing tools; the alternatives with built-in tools need a commercial licence (Highcharts Stock, TradingView Advanced Charts). Drawings must also work from the keyboard (spec §6, WCAG 2.5.7) and survive the raw/adjusted toggle.
- **Decision:**
  - Drawings are rendered by one series primitive (`lib/chart/drawing-primitive.ts`), the library's own plugin interface: the chart redraws them on every pan, zoom and resize, and nothing is added to the bundle. Points are stored as session dates and prices and placed by session index, so a date on a weekend or holiday lands on the session before it.
  - Each drawing keeps the price basis it was drawn on (`raw` or `adjusted`) and shows only on that chart; the list says how many are on the other one. Converting points across a split or dividend would need per-date adjustment factors in the browser and would quietly move the owner's lines.
  - Clicks on the price pane are read from native click events and converted with the chart's coordinate functions. The library's own click subscription swallows a second click within 500 ms of the first (it waits for a double click), which loses the second point of a quickly drawn line. A pointer that moves more than 5 pixels between press and release is a pan, not a point.
  - Every drawing is also listed in words with a delete button, and a form adds any of them from the keyboard with dates and prices. Saved through server actions (owner only, validated with the same schema as the chart, at most 100 per chart and basis) in `public.chart_drawings` (migration 16).
  - Behind the `drawings` flag, on by default. The web app now lists `zod` (already used by every package, same version) as a direct dependency for the shared drawing schema.
- **Consequences:** drawings cannot be dragged to a new place; delete and redraw instead. A drawing made on raw prices does not follow a later split.

## ADR-030: A dashboard arranged with buttons first, dragging second

- **Context:** spec §6 asks for a customizable dashboard with a drag-and-drop widget grid saved per user ("react-grid-layout or similar"), and WCAG 2.2 (2.5.7) requires a way to do every drag without dragging. A grid library brings a dependency, free-form sizes and its own accessibility gaps, for a page one person arranges now and then.
- **Decision:**
  - The layout is an ordered list of widgets, each full or half width and shown or hidden (`public.dashboard_layouts`, migration 16; validated on read, so a stored layout with unknown or repeated widgets still loads, and widgets added later appear at the end). Eight widgets: index ETFs, watchlists, recent alerts, top gainers, top losers, portfolios, coming up (earnings and economic releases) and a saved screen's results; each labels its figures with source and as-of date like the rest of the app.
  - "Customize" turns on an editing bar per widget: move up or down among the visible widgets, full or half width, hide (and show again from a list), and which saved screen the screen widget shows. Each change is one server action that returns the saved layout; the page refreshes without navigating and focus goes back to the button that was used, so a keyboard user can press Enter repeatedly to move a widget several places.
  - On a desktop, a widget can also be dragged by its handle onto another (native HTML5 drag and drop, no library); the drop is the same "order" change. Touch screens use the buttons.
  - Behind the `dashboard` flag; when it is off, the standard layout shows and nothing can be changed.
- **Consequences:** no free-form grid: two columns on wide screens, one on narrow ones. A drag needs both widgets on screen, since the page does not scroll while dragging; the buttons work anywhere.

## ADR-031: Insider transactions read from each Form 4's XML, kept as filed

- **Context:** spec §2.3 and §5.13 ask for Form 4 insider transactions with a transaction-code legend and a descriptive cluster-buy flag. EDGAR keeps each Form 4's XML next to the page its index links (the primary document `xslF345X06/form4.xml` is the rendered view of `form4.xml`). SEC's quarterly insider data sets exist too, but lag by months. Three facts shape the design: a Form 4 is listed under its issuer and under every reporting owner (Goldman Sachs' list includes its own filings about other companies); a 4/A carries only the lines it adds or corrects, with nothing tying a corrected line to the original (Form 4 General Instruction 9); and filers leave values out, often explaining why in a footnote.
- **Decision:**
  - Each Form 4 or 4/A is read from its XML by `parseOwnershipDocument`, which refuses anything outside the schema (an unknown code, a malformed number or date) instead of guessing. Values left out stay null, with the line's footnote ids; nothing is filled in. XML is read by a small strict reader of our own (`packages/market-data/src/xml.ts`: no DOCTYPE, only the five predefined entities, nesting limit). The usual library, fast-xml-parser, now brings six further packages for a document this simple.
  - Filings are stored by the issuer's CIK, with their reporting owners and footnotes, and their lines as filed. A filing about another company is stored under that company. Amendments sit beside the filings they amend; totals of purchases and sales leave 4/A lines out and say so, rather than counting a corrected line twice.
  - A filings refresh that stores new Form 4s filed in the last 30 days queues a read of each (`ingest-insider`, one SEC request, through the shared 8-per-second limiter). A nightly sweep at 22:30 ET catches any it missed, and `pnpm worker insiders --days 730` reads history. A document the parser refuses is recorded with the parser version and skipped until the version changes; a network failure fails the job so it retries.
  - `@market/ownership` holds the legend (SEC's twenty codes in SEC's own words, from Form 4 General Instruction 8), role labels, purchase and sale totals, and purchase clusters: periods in which at least three different insiders bought on the open market (code P, Table I, acquired) within 30 days of each other. Joint filers count as one insider, and overlapping periods merge. These are shown as what was filed, never as a signal.
- **Consequences:** a year of history for 50 large companies is about 15,000 requests (about half an hour at the limit); new filings after that are a few a day. Verified live on 2026-10-02: the 683 Form 4s filed in the previous 90 days by the 49 registrants in the development database were all read, all HTTP 200, none refused. Holdings-only lines and Forms 3 and 5 are not stored yet.

## ADR-032: Institutional holdings from SEC's 13F data sets, tied to our securities by CUSIP

- **Context:** spec §2.3 and §5.13 ask for 13F holders by quarter with changes in position, labelled "As of quarter end [date], filed [date]; 13F data is reported up to 45 days after quarter end." SEC publishes the 13F filings as quarterly data sets: a zip of about 100 MB per three months of filing dates, with about 3.8 million holding rows. Holdings name securities by CUSIP, which our securities master does not have (spec §4: "FIGI/CUSIP if licensed"). SEC's twice-monthly fails-to-deliver files list each CUSIP with its ticker and issue name. Amendments come in two kinds: a RESTATEMENT replaces the report, and NEW HOLDINGS adds entries to it.
- **Decision:**
  - **CUSIPs** come from the six newest fails-to-deliver files (about three months). A CUSIP matches one of our listings when the ticker is the same once separators are dropped (SEC writes BRK-B as BRKB) and the names agree: they share an identifying word, or begin with the same four letters and digits once punctuation is gone ("WAL-MART INC (DE)" and "Walmart Inc."). A mismatch is recorded as a data-quality warning, never matched, so a reused ticker cannot attach one company's holdings to another. Synthetic listings never get one. CUSIPs are used only to join SEC's own files and are never shown or exported.
  - **Data sets** are found from SEC's listing page (the links follow no single pattern), downloaded whole off-peak (at most 600 MB) and read from disk. Only our CUSIPs' share rows are kept: puts, calls and principal amounts are left out. CUSIPs are upper-cased (some filers write them in lower case), short CIKs are padded, and value is dollars for filings from 2023-01-03 on (thousands before, per SEC's notes). Summary pages whose row count disagrees with the rows are listed per data set.
  - **Positions as filed:** each filer's position at each quarter end is the latest holdings report or restatement (by filing date, then accession number) plus the NEW HOLDINGS amendments filed after it, as SEC defines them. It is rebuilt from every stored filing whenever one of that filer's filings for that quarter arrives, so the result does not depend on the order data sets are read in. A position built from several filings lists each of them. A NEW HOLDINGS amendment whose original we do not have yields no position, rather than a partial one.
  - **Retention and schedule:** eight quarter ends are kept. At 23:00 ET the worker looks at the listing (one request) and reads the two newest data sets if either is new. `pnpm worker 13f` reads them on demand.
  - **Dependency:** `yauzl` 3.4.0, because Node has no zip reader. It is MIT-licensed, maintained (last release June 2026), about 110 KB, with one MIT dependency (`pend`), and runs in the worker only, so the web bundle is unchanged.
- **Consequences:** each data set costs one 100 MB download and about 25 seconds. Fifty large companies give about 180,000 positions a quarter. Verified on 2026-10-02 against SEC's two newest data sets: for seven securities over seven quarter ends, all 49 holder counts and share totals equal an independent Python computation over the full files. 51 of 52 real listings matched; GE did not, because SEC's file calls it GE Aerospace while SEC's ticker list still says General Electric. Holdings are as filed: positions that two managers both report are not de-duplicated, and only managers with $100 million or more in 13F securities file at all.

## ADR-033: Short interest from FINRA's Query API, with the owner's free credential

- **Context:** spec §2.5 asks for short interest from the provider if licensed, or FINRA's twice-monthly files, always with the settlement date. FINRA publishes short interest for all exchange-listed and OTC equities (exchange-listed only since June 2021), on the seventh business day after each settlement date. Its website terms (2023-11-09) limit site content to non-commercial personal use and forbid building a database from the site and harvesting it with automated tools, so the downloadable files are out. Its API terms (FINRA API Terms of Service, updated 2026-03-19; Specific Terms for Equity Data, 2022-12-20) do allow this use: Public credentials (free, for individuals through FINRA's API Console), non-commercial personal or professional use, derived data, no retention limit, and naming FINRA as the data's owner and source. Every API call is meant to carry a credential.
- **Decision:**
  - A `finra` provider ("regulator" kind) calls the Query API (`otcMarket/consolidatedShortInterest`) with an OAuth client-credentials token, reused for up to 30 minutes and replaced once on a 401. It asks for 100 symbols per query and pages through FINRA's 5,000-row limit. Credentials are `FINRA_API_CLIENT_ID` and `FINRA_API_CLIENT_SECRET`, optional and taken together; without them nothing runs and the tab says short interest is unavailable.
  - Our tickers are matched to FINRA's symbols without separators (FINRA writes BRK.B as BRKB), and FINRA's issue name must agree with ours (ADR-032's rule), so a reused ticker is reported rather than stored. Synthetic listings are never sent.
  - Figures are stored as FINRA publishes them, one row per security and settlement date. FINRA's days to cover is kept, except where average volume is zero: FINRA prints 999.99 there, and we store no value. Revision and split flags are kept. Each daily run (19:30 ET) asks again from five weeks before the latest stored date, so revisions replace earlier rows.
  - Licensing: owner-only display (`personal_dev` tier), no export, attribution "Short interest: FINRA, the owner and source of this data". FINRA's data is never committed: fixtures hold made-up values in FINRA's field layout.
- **Consequences:** short interest waits for the owner's credential. The record's fields were checked against FINRA's published data on 2026-10-02; the token exchange and the POST filter syntax follow FINRA's documentation and stay unverified until the credential exists (runbook). One run is a handful of requests.

## ADR-034: An Ownership tab that shows filings as filed, and alerts on insider purchases

- **Context:** spec §5.1 lists Insiders and Institutions among the ticker page's tabs. §5.13 asks for a Form 4 table with a transaction-code legend and descriptive cluster-buy detection, 13F holders by quarter with changes in position and the 45-day label, and short interest with its settlement date and days to cover. §5.14 lists "insider purchase" among the alert types. Every number needs its source and as-of date (MUST DO #7), and nothing may read as a signal or advice (§13). Steps H1 to H3 (ADR-031 to ADR-033) store the data.
- **Decision:**
  - One **Ownership** tab (`/stocks/[ticker]/ownership`) with three sections, behind the `ownership` flag (on by default; off hides the tab, answers 404 for the page and withdraws the alert kind).
  - **Insiders:** the last 12 months of Form 4 lines, newest first. Each line shows the insider and role, SEC's code with its label, the 10b5-1 box when checked, derivative securities by name, footnotes as filed, shares signed as filed (+ acquired, − disposed), price, holdings after (direct or indirect, with its nature) and a link to the filing with its acceptance time. Above the table: open-market purchases and sales over the last 90 days from original filings only (amendment lines are counted and named as left out, since a 4/A repeats the lines it corrects), and the periods in which three or more insiders bought within 30 days (ADR-031). The legend gives SEC's own wording; the note reads "Transactions as reported on Form 4. Shown as filed, for information only: not a signal or a recommendation."
  - **13F holders:** one quarter end at a time (newest by default, others a click away). The label is §5.13's, with the range of filing dates when the positions come from several filings (`COPY.thirteenF`). Changes compare only with the calendar quarter just before; when that quarter is not loaded, none are shown rather than comparing across a gap. "No longer listed" counts filers that held the security last quarter and filed a holdings report this quarter without it; a filer that has not filed yet is not counted. The 50 largest positions and departures are listed, with the full counts, each linked to its filings on EDGAR. CUSIPs stay out of the page: it receives only how many match (ADR-032).
  - **Short interest:** the last 12 settlement dates with FINRA's previous figure, average daily volume, days to cover (blank where FINRA reports no volume) and its revised and split flags, labelled "Settlement date … · Source: FINRA" with FINRA's required attribution. Without the credential the section says how to get one.
  - **Insider-purchase alert** (`insider_purchase`, behind both `alert_types` and `ownership`): fires when a Form 4 for the company reports an open-market purchase (code P, Table I, acquired) worth at least a chosen amount at the filed prices; 0 means any purchase. Lines without a price count toward shares but not toward value; amendments do not fire it. Like filing alerts (ADR-028), it reads filings stored since it last looked and accepted after it was created, with the latest accession number as its event key. Storing a Form 4 with a purchase queues the evaluation at once (job `evaluate-alerts/insiders/<accession>`), and the 18:50 run checks again. Creating one needs a security with a CIK. Emails and notifications name the insider, role, shares, prices, dates and value at the filed prices, and link to the filing on www.sec.gov.
- **Consequences:** the tab is only as complete as its data: Form 4s for listings with a CIK, 13F positions only for listings with a matched CUSIP and only from the data sets read, short interest only with the owner's FINRA credential. The E2E seed holds made-up rows for TEST_FIN in all three, and data set names SEC never uses, so a seeded database cannot mistake them for real sets.

## ADR-035: News from the press releases companies file with SEC and from Finnhub, kept as given

- **Context:** spec §5.12 asks for news from licensed feeds only (never scraping paywalled sites), de-duplicated by link and headline similarity, tagged with tickers, shown with headline, source, time and a link out, with full text stored only if the license permits. The Phase 2 plan (decision 2) chose Finnhub company news on the owner's free key plus the press releases companies file with SEC. Finnhub's terms (read 2026-10-02): personal use, no sharing of data or results derived from it, deletion if the subscription ends; nothing specific to news. A company files its releases as Exhibit 99 to Form 8-K; the filing index lists each document's type, but the release has no structured headline.
- **Decision:**
  - **Press releases:** for each 8-K with exhibits (Item 9.01) filed by a registrant we hold, the filing index is read for the lowest-numbered EX-99 document in HTML or text, then that document: two SEC requests per 8-K through the shared limiter, once per 8-K (`market.press_release_checks`, with a reader version so an improved reader can read them again). The evening filings refresh queues 8-Ks filed in the last 30 days; a sweep at 22:45 ET catches misses; `pnpm worker press-releases` reads history.
  - **Headline and lead:** the dateline paragraph ("SANTA CLARA, Calif.—Aug. 26, 2026―NVIDIA … today reported") anchors the reading. The headline is the first line before it that is not an exhibit label, a contact detail (names, email, telephone, "Investor Relations"), an address, the company's own name, a release instruction or a period kicker ("Second Quarter 2026"); lines it continues on are joined (a line broken mid-phrase, or the next line of a document laid out line by line at the same size). The lead is the dateline paragraph, cut at a sentence near 500 characters. A document without a dateline (slide decks, letters, tables) gets no headline: the item says what was filed, from the 8-K's items ("Microsoft Corp filed Exhibit 99.1 with a Form 8-K: Regulation FD Disclosure"), and is marked as described. Nothing is invented.
  - **Company news:** Finnhub's `/company-news` for each company we hold (equities and ADRs with a real listing), at 07:00 and 17:00 ET, from two days before its latest stored article (first run: 30 days). Finnhub's related symbols tag our other listings (its BRK.B is our BRK-B). An item without a headline, with a link that is not http(s), or with an impossible time is left out and recorded as a data-quality issue.
  - **Stored as given:** headline, summary, outlet, link and time, never the article itself. One link is one article, compared without tracking parameters, "www."/"m.", trailing slashes and fragments; a second source adds its tags. A headline sharing at least 80% of its words (stopwords aside; at least four words) with one stored for the same security within 48 hours is a copy of the first one stored (`duplicate_of`): kept, and shown under it. Kept 400 days.
  - **Display:** a News tab (`/stocks/[ticker]/news`) behind the `news` flag: the last 90 days, newest first; each item with its kind, outlet, time in ET, summary and a link out (new tab, `noopener noreferrer nofollow`); copies listed as "Also"; filters for press releases and news; a DataLabel per source. Finnhub items are owner-only; press releases are public domain.
  - **Package:** `@market/news` (new, pure) holds link and headline comparison.
- **Consequences:** live check 2026-10-02 on the 132 8-Ks filed since June 4 by the 50 registrants in the development data: 229 SEC requests, all HTTP 200, in 29 seconds; 97 carried an EX-99 exhibit; 82 headlines were read, every one correct on review, and the other 15 (slide decks, letters, methodology and table documents, one release laid out one block per page) were described. The Finnhub response shape follows its documentation and stays unverified until the owner's key exists. Copies are only found among items about the same security. Sentiment comes next (step I2).
