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

## ADR-008: Basic auth for the Phase 0 admin page

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
