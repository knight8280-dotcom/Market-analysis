# Phase 1 Plan: Personal Analytics MVP

**Status:** approved 2026-09-30; in progress (see Progress at the end).
**Prepared:** 2026-09-30.
**Scope sources:**

- Phase 1 prompt (`docs/BRIEF.md` Part C), narrowed by the owner's decision that the system is **for personal use only** (`/CLAUDE.md` scope note, ADR-015);
- the owner's "use your defaults" for the open decisions. The defaults are restated below as they apply to personal use.

## (a) Goal

Turn the Phase 0 data layer into a private analytics app that only the owner uses, running on the owner's machine:

- real end-of-day prices for a chosen universe, from a Tiingo personal key;
- fundamentals from SEC EDGAR;
- ticker pages with interactive charts and indicators;
- a financials viewer, a screener with saved screens, and watchlists that update live;
- earnings, economic and dividend calendars, and a sector heatmap;
- email alerts to the owner, and a portfolio tracker.

Every number shows its source and as-of time.

**Dropped from the brief's Phase 1** because they only matter for a public or commercial site: Stripe billing and tiers, SEO pages and sitemaps, public legal pages, cookie consent, marketing rules, vendor display contracts.

## (b) Assumptions

1. **Local first.** Postgres 17 and Redis 7 run in Docker Compose. The web app binds to `127.0.0.1` and the worker runs alongside it. Cost: $0.
   - A private cloud deploy is an optional final step (group L). It needs real authentication (Supabase Auth), because personal-plan data must never be reachable by anyone else.
2. **Prices: Tiingo free tier.** The brief lists 500 unique symbols/month, 50 requests/hour and 1,000 requests/day; to verify.
   - The default universe is about 65 symbols: the 50 large caps used in the EDGAR test, SPY, QQQ, IWM, DIA and the 11 sector SPDRs, plus anything you add.
   - The first 10-year backfill is paced by the rate limiter, so it takes a few hours.
   - Tiingo Power (about $30/month) removes the limits if you want full-market screening. The code is the same either way.
   - Until you add a key, everything runs on synthetic data, with the SAMPLE DATA banner.
3. **Fundamentals: SEC EDGAR** (free, already working). Sector and industry come from EDGAR's **SIC codes**, grouped into about 11 broad sectors with our own documented mapping. GICS would need a license.
4. **Market cap** = latest reported shares outstanding × latest close. ETFs have no XBRL filings, so they show market cap as unavailable rather than an estimate.
5. **Earnings calendar: Finnhub free personal key** (estimates and dates). Without the key, the calendar shows only report dates from EDGAR 8-K Item 2.02 filings.
6. **Economic calendar:** FRED release dates, which need the free FRED key.
7. **Email alerts: Resend's free tier, sending only to your own address.** Resend's test sender needs no domain for that; to verify.
8. **Single owner.** User-owned tables keep `user_id` and RLS policies, so a later cloud deploy or second user needs no schema change. Locally, the server connects with its own privileged role, as in Phase 0.

## (c) Open questions

Nothing blocks starting. Each item has a default.

| #   | Question                                                                                                                       | Default                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tiingo key**: sign up free at tiingo.com and add `TIINGO_API_KEY` to your local `.env` (or this cloud environment's secrets) | Build on synthetic data until it arrives; step A4 verifies the real response shape                                                                                                                                       |
| 2   | **Universe**: which symbols?                                                                                                   | The 65 above; edit `config/universe.json` any time                                                                                                                                                                       |
| 3   | **Hosting**: local only, or also a private cloud deploy?                                                                       | Local only ($0). Cloud is optional group L: roughly $35–45/month (Supabase Pro, since EDGAR facts outgrow the 500 MB free tier, plus a small Render worker; Vercel Hobby is allowed for personal use). Estimates; verify |
| 4   | **Finnhub and FRED keys** (both free)                                                                                          | Optional; features degrade as described above without them                                                                                                                                                               |
| 5   | **Alert email address**                                                                                                        | Your address, from the same env config as the SEC contact; never committed                                                                                                                                               |

## (d) Structure and data model

**New packages:**

| Package               | Contents                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/indicators` | pure TypeScript, no DOM: SMA, EMA, WMA, RSI (Wilder), MACD, Bollinger, ATR, Stochastic, OBV, VWAP, ADX, CCI, Williams %R, Donchian, Keltner, rolling volatility, relative strength |
| `packages/screener`   | filter JSON schema, a SQL compiler over the snapshot table, preset screens                                                                                                         |
| `packages/portfolio`  | lots, time-weighted and money-weighted returns (TWR/XIRR), allocation, benchmark comparison, drawdown                                                                              |
| `packages/ui`         | Tailwind + shadcn/ui components, design tokens, tabular numbers, dark theme by default                                                                                             |

**Worker additions:**

- an EDGAR metadata job (CIK and SIC for universe symbols);
- a job that builds financial statements from XBRL facts;
- a screener snapshot refresh after each end-of-day load;
- Finnhub earnings and FRED release-date ingestion;
- alert evaluation and email sending;
- a per-plan Tiingo rate limiter.

**Web routes:**

- `/login`;
- `/`: dashboard with market overview, watchlists and alerts;
- `/stocks/[ticker]`, with Chart and Financials tabs;
- `/screener`, `/watchlists`, `/portfolio`, `/calendar`, `/heatmap`, `/alerts`;
- `/admin/data-health`.

**Migrations** (each with a rollback and round-trip test):

| #   | Adds                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | `securities.sic_code`. `sector` and `industry` are filled from SIC; `finnhub` added as a provider                                                                                                    |
| 8   | `market.financial_statements`: per CIK, statement type and period; line items as JSONB with concept, unit, accession and filed date for every value; an as-reported flag                             |
| 9   | `market.screener_snapshot`: one row per security with close, returns, market cap, P/E, P/S, P/B, dividend yield, SMA50/200, RSI14, 52-week high/low, average volume, sector and as-of date           |
| 10  | `market.earnings_events`, `market.economic_releases`                                                                                                                                                 |
| 11  | `public.watchlists`, `watchlist_items`, `portfolios`, `transactions`, `saved_screens`, `alerts`, `alert_events`, `audit_logs`, all with `user_id` and per-user RLS policies (tested with `withRole`) |

## (e) Steps (each verifiable in under 30 minutes)

| #     | Step                                                                                                                                                                           | Verification                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **A** | **Personal-use groundwork**                                                                                                                                                    |                                                                             |
| A1    | License model: an "owner only" display audience for personal plans; `canDisplay` refuses any other audience                                                                    | unit tests                                                                  |
| A2    | `config/universe.json` with symbols and asset classes; Tiingo securities come from it                                                                                          | tests; unknown asset class is refused                                       |
| A3    | Tiingo per-plan rate limits (free: 50/hour and 1,000/day windows; Power: configurable)                                                                                         | limiter integration test                                                    |
| A4    | Live Tiingo shape check with your key (no response committed) → record in `DATA_SOURCES.md`                                                                                    | adapter parses live responses                                               |
| A5    | EDGAR metadata job: ticker map → CIK; submissions → SIC → sector group                                                                                                         | recorded-fixture tests                                                      |
| A6    | Real-universe backfill (10 years, paced) and the daily end-of-day schedule                                                                                                     | run records; staleness monitor green                                        |
| **B** | **App shell and access**                                                                                                                                                       |                                                                             |
| B1    | `packages/ui`: Tailwind, shadcn/ui, tokens, dark theme, tabular numbers                                                                                                        | build and visual check                                                      |
| B2    | Owner login (hashed passcode → signed httpOnly session cookie); the proxy guards every route; the server refuses a non-localhost bind without auth configured                  | proxy and cookie tests                                                      |
| B3    | Layout: nav, ⌘K ticker search, "last updated" indicator                                                                                                                        | Playwright smoke test                                                       |
| B4    | Compliance components: source/as-of tooltip, "End-of-day, as of …" label, stale-data banner, SAMPLE DATA banner                                                                | component tests                                                             |
| **C** | **Indicators**                                                                                                                                                                 |                                                                             |
| C1–C3 | `packages/indicators` in three batches; warm-up periods return `null`                                                                                                          | matches reference fixtures from an established library (TA-Lib) within 1e-6 |
| **D** | **Ticker page**                                                                                                                                                                |                                                                             |
| D1    | Server loader: latest bar, change, source, as-of, market status; delisted and unknown-ticker states                                                                            | integration tests                                                           |
| D2    | Lightweight Charts with attribution; candles, line and volume; timeframes; adjusted/unadjusted toggle; split, dividend and earnings markers                                    | Playwright; 2,500 points render in < 300 ms                                 |
| D3    | Indicator overlays, moved to a Web Worker above 5 overlays                                                                                                                     | Playwright                                                                  |
| **E** | **Fundamentals**                                                                                                                                                               |                                                                             |
| E1    | XBRL concept map for the income statement, balance sheet and cash flow (annual, quarterly, TTM)                                                                                | unit tests on recorded facts                                                |
| E2    | Statement builder job; restatements keep the original and restated values                                                                                                      | integration test                                                            |
| E3    | Financials tab: as-reported toggle, common-size view, year-over-year, a filing link for every period                                                                           | Playwright                                                                  |
| E4    | 10-company check against filed 10-K values, to the dollar                                                                                                                      | documented spot-check table                                                 |
| **F** | **Screener**                                                                                                                                                                   |                                                                             |
| F1    | Snapshot refresh job after end-of-day loads                                                                                                                                    | integration test                                                            |
| F2    | Filter JSON schema and SQL compiler (AND/OR groups, sort, columns)                                                                                                             | results equal a hand-written SQL oracle                                     |
| F3    | Screener UI, saved screens, presets (descriptive names only)                                                                                                                   | Playwright; a saved screen reloads identically                              |
| F4    | Performance at 6,000 synthetic securities                                                                                                                                      | p95 < 1 s                                                                   |
| **G** | **Watchlists**                                                                                                                                                                 |                                                                             |
| G1    | Schema, CRUD, reorder with button alternatives to drag, notes, CSV import/export                                                                                               | RLS policy and CRUD tests                                                   |
| G2    | Server-sent events from the worker's `market-events` channel, at most 1 update/second per symbol                                                                               | integration test                                                            |
| **H** | **Calendars and heatmap**                                                                                                                                                      |                                                                             |
| H1    | Finnhub earnings adapter (fixtures, shape check) and ingest job                                                                                                                | tests                                                                       |
| H2    | FRED release dates; dividends and splits from corporate actions; ICS export                                                                                                    | tests; the ICS file imports                                                 |
| H3    | Sector heatmap: SIC groups, sized by market cap, colorblind-safe palette, keyboard navigation                                                                                  | Playwright; axe                                                             |
| **I** | **Alerts**                                                                                                                                                                     |                                                                             |
| I1    | Alert schema: price cross, % move, earnings upcoming; cooldown and daily cap                                                                                                   | tests                                                                       |
| I2    | Worker evaluator, idempotent per (alert, bar date)                                                                                                                             | fires at most once per crossing                                             |
| I3    | Email to the owner via Resend (captured by a mock server in tests)                                                                                                             | delivery test                                                               |
| **J** | **Portfolio**                                                                                                                                                                  |                                                                             |
| J1    | Transactions: manual entry and CSV import; splits adjust lots                                                                                                                  | tests                                                                       |
| J2    | Returns, allocation, benchmark comparison, dividends received                                                                                                                  | matches a spreadsheet fixture within 0.01%                                  |
| **K** | **Acceptance and docs**                                                                                                                                                        |                                                                             |
| K1    | Playwright end-to-end: log in → watchlist → alert fires → email captured → portfolio import → returns shown; axe with zero critical issues; Lighthouse ticker-page LCP < 2.5 s | CI                                                                          |
| K2    | Docs, runbook and the Phase 1 report                                                                                                                                           | review                                                                      |
| **L** | **Optional private cloud deploy** (only if chosen in question 3)                                                                                                               |                                                                             |
| L1–L3 | Supabase project + Supabase Auth (TOTP), Render worker + Redis, Vercel Hobby; least-privilege database roles                                                                   | deploy smoke test; unauthenticated requests get 401                         |

### Phase 1 acceptance (personal-use version of the brief's criteria)

- The end-to-end journey passes: log in → watchlist → alert fires → email captured → portfolio shows returns.
- Every price shows its source, as-of time and delay label.
- Indicator reference tests pass (within 1e-6).
- axe finds zero critical issues.
- The ticker page's LCP is under 2.5 s.
- The screener's p95 is under 1 s at 6,000 securities, and its results equal the SQL oracle.
- Portfolio metrics match the spreadsheet fixture within 0.01%.
- No route serves data without the owner's session.

**Estimated effort:** about 45 small steps, roughly the brief's Phase 1 window minus the dropped public-product work.

## Progress

Approved 2026-09-30 with the defaults (local only, Tiingo free key when provided, 65-symbol universe, SIC sectors, Finnhub and FRED optional, alert email via Resend, no cloud deploy).

| Group | Status                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | A1, A2, A3, A5 done. A4 (live Tiingo shape check) and the live part of A6 wait for the Tiingo key: `pnpm worker verify-tiingo`, then `pnpm worker bootstrap` (RUNBOOK).          |
| B     | done: `packages/ui`, owner login (ADR-018), app shell with ⌘K search and "last updated", compliance labels and banners; Playwright + axe in CI. D1's ticker header came with it. |
| C–K   | not started                                                                                                                                                                      |
