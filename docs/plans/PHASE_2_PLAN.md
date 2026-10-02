# Phase 2 Plan: Advanced Analytics (personal use)

**Status:** approved 2026-10-02 with the defaults, except that push notifications must work on **mobile and desktop** (owner decision). 2a complete 2026-10-02 ([report](PHASE_2A_REPORT.md)); 2b next.
**Prepared:** 2026-09-30.
**Scope sources:**

- the brief's Phase 2 prompt (`docs/BRIEF.md` Part C) and spec §5.2, §5.6, §5.10–5.16, §9;
- the personal-use scope (`/CLAUDE.md` scope note, ADR-015): one user, runs locally, no public product. Items that exist only for a public site stay out (tiers, per-tier token caps, CAN-SPAM unsubscribe flows for other people).

## (a) Goal

Add research depth on top of Phase 1, all for the owner alone:

- a deterministic **backtesting** engine with bias controls and honest reporting;
- **portfolio risk** metrics (volatility, Sharpe, Sortino, beta, correlations, concentration);
- **valuation** tools: a two-stage DCF and peer multiples;
- **insiders** (Form 4), **institutions** (13F) and **short interest**;
- **news** with model-estimated sentiment, from licensed sources only;
- more **alert** types, delivered within 60 s of new data, plus in-app and browser push;
- chart **drawing tools**, a **customizable dashboard**, an installable **PWA**;
- **AI** features that only state numbers our own tools returned, with citations and evals.

Every new feature ships behind a feature flag (a small table and a settings page; no third-party service).

## (b) Assumptions and defaults

1. **Split into two halves** because the phase is large (33 steps below, several of them big): **2a** backtesting, risk, valuation, alerts, drawing tools, dashboard, flags; **2b** insiders/13F/short interest, news, AI, PWA and push. Each half ends with its own report.
2. **Data stays free where possible:** SEC EDGAR (Form 4, 13F data sets, 8-K press releases), FRED (3-month T-bill for the risk-free rate), FINRA short interest files. Personal-plan terms for each are to be verified and recorded in `DATA_SOURCES.md` before its adapter is built.
3. **Backtests use our database only**, point in time: fundamentals from their `filed_at`, securities including delisted ones, universe membership as of each date. The universe is whatever is loaded (65 symbols by default; wider with Tiingo Power).
4. **Risk-free rate** is FRED `DTB3`. Without a FRED key, Sharpe and Sortino show as unavailable rather than using zero.
5. **AI:** the owner's own API key for a frontier model with tool calling, a monthly spending cap in env, prompts and tool calls logged locally. Numbers in answers are verified against tool outputs before display (§5.16, §9).
6. **Push notifications on mobile and desktop** (owner decision, 2026-10-02).
   - Desktop browsers work on `localhost`, which browsers treat as a secure context.
   - A phone has to open the app over HTTPS with a real certificate to install it and subscribe. By default the phone reaches the app over **Tailscale**: the computer running the app gets a private `https://….ts.net` address that only the owner's own signed-in devices can open, so nothing is on a public URL. Tailscale's personal plan is free (terms to verify before J3). It needs Tailscale on the computer and the phone, and the computer has to be on.
   - iPhone: iOS 16.4 or later, with the app added to the Home Screen (Apple only allows web push for installed web apps). Android: Chrome, installed or not.
   - The alternative is an always-on private cloud deploy (Phase 1 plan group L, roughly $35–45 a month, estimate). It costs money, so it happens only if the owner chooses it.
   - Push messages go from our worker to the browser vendors' push services (Google, Apple, Mozilla, Microsoft), encrypted end to end (RFC 8291) and signed with our VAPID key. Only push-service hosts on an allowlist are ever contacted.
7. **Options analytics stay out** unless the owner picks an options data source with personal-use terms (§5.11 requires the license first).

## (c) Decisions (2026-10-02)

| #   | Question                      | Decision                                                                                                                                  |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **LLM provider and key** (2b) | Anthropic's API with the owner's own key and a monthly cap (`AI_MONTHLY_BUDGET_USD`, default $10); cost to verify against current pricing |
| 2   | **News source** (2b)          | Finnhub company news on the same free personal key, plus SEC 8-K press-release exhibits (public). No scraping                             |
| 3   | **Sentiment model** (2b)      | The same LLM with a fixed, versioned prompt, labelled "Model-estimated sentiment"                                                         |
| 4   | **Broker CSV templates**      | No brokers named, so the generic template stays and step C3 is dropped; templates can be added later from an export file                  |
| 5   | **Options**                   | Out                                                                                                                                       |
| 6   | **Push notifications**        | **Mobile and desktop** (owner's change); phone access as in assumption 6                                                                  |
| 7   | **Order**                     | 2a first, then 2b                                                                                                                         |

## (d) Structure and data model

**New packages:**

| Package              | Contents                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/backtest`  | strategy JSON schema (rules from `@market/indicators`), deterministic engine (next-bar-open fills, costs, dividends, cash drag), metrics, walk-forward |
| `packages/valuation` | two-stage DCF, sensitivity grid, multiples and peer statistics; pure functions                                                                         |
| `packages/ai`        | tool definitions over our database, the numeric verifier, citation builder, refusal rules, eval runner (2b)                                            |

`packages/portfolio` gains risk metrics; `packages/alerts` gains condition types; `packages/market-data` gains Form 4, 13F data set, FINRA short interest and news adapters.

**Migrations** (each with a rollback and round-trip test):

| #   | Adds                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12  | `ops.feature_flags`                                                                                                                                                                                                                          |
| 13  | `public.strategies`, `public.backtest_runs` (code version, data snapshot id, assumptions, status), `public.backtest_results` (metrics, equity curve, trades)                                                                                 |
| 14  | `public.valuation_scenarios`                                                                                                                                                                                                                 |
| 15  | alert kinds (indicator, volume spike, new filing, insider purchase, screen membership), alert state and snooze, event keys; `public.notifications` (in-app). `public.push_subscriptions` moves to J2's migration, with the code that uses it |
| 16  | `public.chart_drawings`, `public.dashboard_layouts`                                                                                                                                                                                          |
| 17  | `market.insider_transactions`, `market.institutional_holdings`, `market.short_interest` (2b)                                                                                                                                                 |
| 18  | `market.news_articles`, `market.news_tickers`, sentiment with model version (2b)                                                                                                                                                             |
| 19  | `ops.ai_requests` and `ops.ai_tool_calls` (prompt and tool logs, PII redacted) (2b)                                                                                                                                                          |

**Worker additions:** backtest runner queue (CPU-bound, one at a time, time limit); event-driven alert evaluation on `bars_updated`; Form 4 and 13F ingestion; FINRA short interest; news ingestion and sentiment; push delivery.

**Web routes:** `/backtests`, `/stocks/[ticker]/valuation`, `/stocks/[ticker]/ownership`, `/stocks/[ticker]/news`, `/notifications`, `/settings` (flags, push), an assistant panel (2b).

## (e) Steps (each verifiable in under 30 minutes)

| #     | Step                                                                                                                                                                                    | Verification                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A** | **Flags and groundwork (2a)**                                                                                                                                                           |                                                                                                                            |
| A1    | Migration 12, flag helper, `/settings` page; every Phase 2 route checks its flag                                                                                                        | tests; a disabled flag hides the route (E2E)                                                                               |
| **B** | **Backtesting engine**                                                                                                                                                                  |                                                                                                                            |
| B1    | Strategy schema: entry/exit rules on indicators, sizing, stop loss / take profit, rebalancing                                                                                           | schema tests                                                                                                               |
| B2    | Engine: signals on adjusted prices, fills at next bar open, split-aware shares, commission and slippage, dividends in or out, cash drag                                                 | unit tests                                                                                                                 |
| B3    | Point-in-time data access: fundamentals by `filed_at`, universe as of each date including delisted securities                                                                           | survivorship fixture (a delisted stock appears in historical universes)                                                    |
| B4    | Metrics: CAGR, volatility, Sharpe, Sortino, max drawdown, Calmar, win rate, profit factor, exposure, turnover, monthly table                                                            | independent reference script (like the portfolio fixture)                                                                  |
| B5    | Golden and canary tests                                                                                                                                                                 | buy-and-hold matches independent total return; a look-ahead strategy is rejected or gets no fills                          |
| B6    | Walk-forward and parameter sweep with an overfitting warning above a combination threshold                                                                                              | tests                                                                                                                      |
| B7    | Worker job with code version and data snapshot id; re-running gives identical results                                                                                                   | reproducibility test                                                                                                       |
| B8    | `/backtests` UI: builder, runs, equity curve vs benchmark, trade log, assumptions panel, required disclosures                                                                           | Playwright; axe                                                                                                            |
| **C** | **Portfolio risk**                                                                                                                                                                      |                                                                                                                            |
| C1    | Volatility, Sharpe and Sortino (FRED `DTB3`), drawdown duration, beta and correlation vs benchmark, holdings correlation matrix, top-10 weight and HHI, daily P&L                       | extended spreadsheet fixture within 0.01%                                                                                  |
| C2    | Risk panel with method and risk-free source in tooltips; allocation by asset class                                                                                                      | Playwright; axe                                                                                                            |
| **D** | **Valuation**                                                                                                                                                                           |                                                                                                                            |
| D1    | Two-stage DCF and WACC × terminal-growth sensitivity                                                                                                                                    | hand-built spreadsheet fixture                                                                                             |
| D2    | Valuation tab with editable inputs from statements, saved scenarios, the required "calculator, not a price target" copy                                                                 | inputs update outputs within 100 ms (E2E timing)                                                                           |
| D3    | Peers by SIC industry and market cap (editable); P/E, EV/EBITDA, P/S with median, percentile and history                                                                                | tests; values traceable to statement lines                                                                                 |
| **E** | **Alerts expansion**                                                                                                                                                                    |                                                                                                                            |
| E1    | Indicator conditions (RSI below/above, SMA cross), volume spike, new filing by form type, screen membership change                                                                      | evaluator tests; once per crossing                                                                                         |
| E2    | Evaluate on `bars_updated` and filing ingestion instead of only at 18:50                                                                                                                | delivery under 60 s after data arrival (integration test)                                                                  |
| E3    | In-app notifications with snooze and delete; links in emails to manage the alert                                                                                                        | Playwright                                                                                                                 |
| **F** | **Drawing tools and dashboard**                                                                                                                                                         |                                                                                                                            |
| F1    | Trendline, horizontal line, Fibonacci retracement, rectangle, text on the chart; saved per security                                                                                     | Playwright: draw, reload, still there                                                                                      |
| F2    | Dashboard widgets (watchlist, movers, alerts, portfolio summary, calendar, screen results), layout saved                                                                                | Playwright; keyboard reordering; axe                                                                                       |
| **G** | **2a acceptance and report**                                                                                                                                                            | CI; report                                                                                                                 |
| **H** | **Ownership and short interest (2b)**                                                                                                                                                   |                                                                                                                            |
| H1    | Form 4 parser and ingestion (transaction-code legend, descriptive cluster-buy flag)                                                                                                     | recorded SEC fixtures                                                                                                      |
| H2    | 13F from SEC's quarterly data sets, mapped to our securities; "as of quarter end, filed" labels                                                                                         | sample holdings equal the data set                                                                                         |
| H3    | FINRA short interest with settlement date and days to cover                                                                                                                             | fixture tests                                                                                                              |
| H4    | Ownership tab; insider-purchase alert                                                                                                                                                   | Playwright; axe                                                                                                            |
| **I** | **News (2b)**                                                                                                                                                                           |                                                                                                                            |
| I1    | News adapter(s) from question 2, deduplication by URL and headline similarity, ticker tagging                                                                                           | fixture tests                                                                                                              |
| I2    | Versioned sentiment, shown as model-estimated with an explanation                                                                                                                       | tests; version stored per article                                                                                          |
| **J** | **PWA and push on mobile and desktop (2b)**                                                                                                                                             |                                                                                                                            |
| J1    | Installable PWA: manifest, icons, service worker with an offline shell (no personal data cached beyond the session), "last updated" when offline; bottom navigation on phones (spec §6) | Playwright at desktop and phone sizes; axe; Lighthouse installability                                                      |
| J2    | Web Push: VAPID keys in env, per-device subscriptions, encrypted payloads, push-service host allowlist, notifications with snooze and delete actions; alerts choose email, push or both | payload decrypted by a test push service; service worker shows the notification (Playwright, desktop and mobile emulation) |
| J3    | Private phone access: Tailscale HTTPS address, host allowlist, secure cookies over HTTPS; runbook for installing on iPhone and Android                                                  | the owner's phone check (runbook); automated checks for the host and cookie rules                                          |
| **K** | **AI (2b)**                                                                                                                                                                             |                                                                                                                            |
| K1    | Tools over our database only; system prompt with the refusal rules; untrusted-document handling (§9)                                                                                    | unit tests                                                                                                                 |
| K2    | Numeric verifier: every number in an answer must match a tool result (within rounding) or the answer is regenerated                                                                     | tests with planted wrong numbers                                                                                           |
| K3    | Natural-language screening shown as screen JSON before running; filing summaries with section citations; metric explanations; portfolio Q&A                                             | Playwright                                                                                                                 |
| K4    | 100-question eval set with expected tool calls and numbers; "should I buy X?" red-team set                                                                                              | ≥ 95% numeric accuracy, 0 uncited numbers, 100% compliant refusals                                                         |
| **L** | **2b acceptance and Phase 2 report**                                                                                                                                                    | CI; report                                                                                                                 |

### Phase 2 acceptance (personal-use version of the brief's criteria)

- Backtest golden, look-ahead canary and survivorship tests pass; re-runs are identical.
- The AI eval scores at least 95% numeric accuracy with zero uncited numbers; the advice red-team scores 100%.
- Portfolio metrics, now with risk, match the spreadsheet fixture within 0.01%.
- The DCF matches its spreadsheet fixture, and input changes update outputs within 100 ms.
- Alerts are delivered within 60 s of the data that triggers them, at most once per crossing.
- Push notifications arrive on desktop and on the owner's phone (automated for payload delivery and the service worker; the phone itself is checked by the owner).
- axe finds zero critical issues; the ticker page's LCP stays under 2.5 s.
- No route serves data without the owner's session; every number shows its source and as-of date.

**Estimated effort:** 34 steps as listed (20 in 2a, 14 in 2b); the larger ones (B2, B8, J2, K3, K4) will split into smaller commits.

**Cost:** $0 for data and hosting as now; the AI features add the model's usage cost, capped by `AI_MONTHLY_BUDGET_USD`.

## Progress

Approved 2026-10-02 with the defaults, except push notifications on mobile and desktop.

| Group                      | Status                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Feature flags            | done 2026-10-02: flag registry with database overrides, `/settings` (ADR-024)                                                                                                                                                                                                                                                                             |
| B Backtesting              | done 2026-10-02: engine, metrics and validation (46 unit tests), migration 13, worker runs in a thread (15 integration tests), builder and reports (3 E2E) (ADR-025)                                                                                                                                                                                      |
| C Portfolio risk           | done 2026-10-02: shared `@market/metrics` (ADR-026), risk measures checked against the extended spreadsheet fixture within 0.01%, risk panel with methods in tooltips, allocation by asset class; `portfolio_risk` flag added at G                                                                                                                        |
| D Valuation                | done 2026-10-02: `@market/valuation` checked against a hand-built spreadsheet fixture (ADR-027), migration 14, Valuation tab with sourced inputs, sensitivity grid, saved scenarios, peers and five-year history (3 E2E; recompute under 100 ms)                                                                                                          |
| E Alerts and notifications | done 2026-10-02: RSI, moving-average, volume, filing and screen conditions (37 unit tests); evaluation on its own queue as data arrives (migration 15; about 0.1 s from the end-of-day job to the email through real queues; 9 integration tests); in-app notifications with snooze, dismiss and delete, alert pages linked from emails (3 E2E) (ADR-028) |
| F Drawings and dashboard   | done 2026-10-02: drawing tools (migration 16; series primitive, native clicks, keyboard form, basis-specific; ADR-029) and a dashboard of eight widgets arranged with buttons (focus kept) or by dragging, saved per user (ADR-030); 4 E2E                                                                                                                |
| G 2a acceptance            | done 2026-10-02: every 2a criterion met ([`PHASE_2A_REPORT.md`](PHASE_2A_REPORT.md)); the check added the missing `portfolio_risk` flag (E2E)                                                                                                                                                                                                             |
| H–L (2b)                   | not started                                                                                                                                                                                                                                                                                                                                               |
