# Market Analysis

Stock market analytics publisher. It is **not** a broker or an investment adviser; see `CLAUDE.md` for the standing specification and `docs/` for architecture, data sources and compliance.

**Status:** Phase 0 (foundations and data layer). See `docs/plans/PHASE_0_PLAN.md`.

## Quickstart

Requirements: Node 24 (22.12+ works), pnpm 10, Postgres 17 and Redis 7 (via `docker compose up -d`, or native installs).

```sh
pnpm install
cp .env.example .env       # fill in local values; never commit .env
pnpm lint && pnpm typecheck && pnpm test
```

All data in development and test is synthetic (`TEST_` tickers). Real market data must never be committed or shown to anyone else without a display license (see `docs/DATA_SOURCES.md`).
