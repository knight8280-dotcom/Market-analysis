# Original Build Brief (verified as of September 30, 2026)

This is the project's founding brief, stored so every session has the research behind the spec. **Part B (the Master Build Prompt) lives in [`/CLAUDE.md`](../CLAUDE.md)** and is left out here to avoid two copies drifting apart. Everything else is reproduced as given. Vendor prices and terms were accurate on the date above; re-verify them before signing anything.

# Master Build Prompt: Full-Scale Stock Trading Analytics Website

Build it, but settle data licensing before you write any feature code. Almost every cheap market-data plan is licensed for personal use only. Massive (formerly Polygon.io) says plainly that showing its data to anyone else "including testers and internal staging users" requires a Business plan.\[1\] The realistic floor for legally displaying US stock data on a public site is therefore about $250–$500 a month, not $29. The prompt below is built around that constraint, a provider-abstraction layer, and a no-fabricated-data rule.

## TL;DR
- **Budget for data display rights first.** Displaying data publicly needs a commercial "display/redistribution" license. The cheapest verified paths are Tiingo's EOD+IEX redistribution tier ($250/month for startups), Twelve Data's Business "Venture" plan ($499/month) and Massive's Stocks Business plan ($2,499/month). Free SEC EDGAR, FRED and Treasury data fill in fundamentals and macro.
- **Stay a publisher.** Offer impersonal analytics, research, screening, charting, portfolio tracking, alerts and backtesting. Do not offer personalized recommendations or order execution. This keeps you inside the Investment Advisers Act publisher's exclusion as interpreted in *Lowe v. SEC* (1985). Show clear "not investment advice," data-delay and hypothetical-performance disclosures everywhere.
- **Hand the AI builder the phases one at a time.** Paste the master prompt below as a standing spec, then feed it Phase 0 → 3 separately: foundations/data layer, MVP, advanced analytics, then monetization/scale. The builder must plan first, work in small tested increments, keep secrets out of code, and never present mock data as real.

## Key Findings

**1. Data licensing is the binding constraint, not technology.**
- **Massive (ex-Polygon.io, rebranded October 30, 2025):**
  - Individual plans: Basic $0 (5 calls/min, 2 years of history, end-of-day), Starter $29 (15-minute delayed), Developer $79, and Advanced $199 (real-time, non-professionals only).\[2\]
  - Its knowledge base says Individual plans are "a personal license" that "stops the moment the data reaches another person's screen," and that this "applies during development, not only at launch."\[1\]
  - Stocks Business is $2,499/month with "No Exchange Fees or Approvals" and real-time Fair Market Value. Exchange expansions include Full Market Delayed at $499/month and Full Market real-time at $1,999/month.\[3\]
  - Qualifying startups "can get 25% or more off their first year."\[3\]
- **Twelve Data** restructured pricing in March 2026, according to its "March 2026 updates" post. Business plans now run "from Basic (free) through Venture ($499), Enterprise ($1,099), and fully custom Enterprise+," and "Annual billing takes 17% off any paid plan."
  - Individual plans (Grow $79, Pro $229, Ultra $999) are "personal, internal, and non-commercial."\[4\]
  - The Business "Venture" plan ($499/month, $414/month billed annually) is described as "ideal for companies showcasing data on client-facing apps or websites" and includes "External display data access," real-time US stocks and fundamentals.\[5\]
- **Tiingo:**
  - Power ($30/month) and Commercial ($50/month) are internal-use only.\[6\]
  - EOD + IEX display redistribution costs $250/month for startups or $500/month for enterprise.\[7\]
  - Fundamentals display redistribution costs $200/month for startups or $500/month for enterprise.\[8\]
- **FMP, EODHD and Finnhub** all sell personal plans cheaply but require separate commercial terms for display:
  - FMP: "requires a specific Data Display and Licensing Agreement," quote-only.\[9\]\[10\]
  - EODHD: the Internal Use plan ($399/month) forbids display; Enterprise is $2,499/month.\[11\]
  - Finnhub: commercial use needs "written approval" via sales.\[12\]
- **Alpaca's** support FAQ says: "you cannot redistribute Alpaca API data for business purpose."\[13\] Use Alpaca only for your own development, not as a public-site feed.\[14\]
- **Exchange fees for delayed data are modest.** The UTP (Nasdaq-listed) plan treats delayed subscriber usage as "Not Fee Liable," but charges an External Delayed Redistributor fee of $250/month per firm plus a $250/year delayed administrative fee.\[15\] Intrinio describes the same structure for its 15-minute delayed SIP product: "$250/year admin fee plus an additional $250/mo fee if you need to display the data… no per-user fees."\[16\] Real-time is different: UTP charges $1/month per non-professional and $24/month per professional subscriber, which brings per-user reporting and entitlement obligations.\[17\]

**2. The regulatory safe harbor is well defined, if you respect it.**
- *Lowe v. SEC*, 472 U.S. 181 (1985) holds that the Advisers Act excludes "the publisher of any bona fide… business or financial publication of general and regular circulation."\[18\]
- The Court drew the line against "hit and run tipsters" and "touts" and against personalized advice. In its words: "The mere fact that a publication contains advice and comment about specific securities does not give it the personalized character that identifies a professional investment adviser."\[19\]\[20\]
- On August 15, 2024, the U.S. District Court for the Southern District of New York granted Seeking Alpha's motion to dismiss in *Lingley et al. v. Seeking Alpha Inc.*, No. 1:23-cv-05849, finding that Seeking Alpha "is protected by the publishers' exclusion." Katten's August 26, 2024 analysis notes the court held that publications meet the "general and regular circulation" test if they are "advertised and sold in an open market and are updated regularly."
- The SEC Marketing Rule (206(4)-1) binds registered advisers, not publishers. Its hypothetical-performance rules are still the best template for backtest disclosures, and it explicitly excludes "interactive analysis tools" from the definition of hypothetical performance.\[21\]\[22\]

**3. Stack notes that change the default architecture.**
- **Supabase no longer supports TimescaleDB on Postgres 17.** Supabase's docs state: "The timescaledb extension is deprecated in projects using Postgres 17. It continues to be supported in projects using Postgres 15, but will need to dropped before those projects are upgraded." Supabase recommends native partitioning with pg_partman. Plan price storage on native Postgres range partitioning, or a separate TimescaleDB/ClickHouse instance.
- **TradingView Lightweight Charts** is free under Apache-2.0 but requires "the 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/" on user-facing pages.\[23\]
- **TradingView Advanced Charts** is not available "for personal use, hobbies, studies, or testing." It is licensed only "to companies for use in public web projects," and it carries a TradingView watermark.\[24\]\[25\]
- **SEC EDGAR** is free but enforces "10 requests/second" and a declared User-Agent in the format "Sample Company Name AdminContact@<sample company domain>.com."\[26\]\[27\]

**4. Competitive landscape.** Table-stakes features today are:
- screener with saved filters
- interactive charts with indicators
- ticker pages with fundamentals
- earnings calendar
- heatmap
- watchlists
- news
- basic portfolio tracking
- alerts

Reference pricing: TradingView runs from free to $199.95/month (Essential $12.95, Plus $28.29, Premium $56.49 on annual billing). Finviz Elite is $39.50/month or $299.50/year. Koyfin's own llm-info page lists a free plan plus "Plus ($39/month)… Premium ($79/month)," with "up to 30% off on annual billing."

Gaps a new entrant can target:
- **Grounded AI** that cites the site's own data, rather than generic chat.
- **Honest backtesting** that is survivorship-bias-free and shows costs and walk-forward results.
- **Portfolio risk analytics for retail users** (factor/benchmark comparison, correlation, drawdown). This is usually locked in pro tools.
- **Unified filings intelligence:** Form 4, 13F and 8-K summaries tied to price reactions.
- **Transparency:** every number shows its source and as-of timestamp, which few competitors do.

---

## Part A — Adjustable Variables (edit before pasting)

Current resolved values are tracked in the table at the top of `/CLAUDE.md`.

| Variable | Default | Notes |
|---|---|---|
| [BRAND_NAME] | — | Your site name |
| [DOMAIN] | — | Needed for SEC User-Agent, email, SEO |
| [TARGET_USER] | Self-directed retail investors and serious hobbyist traders (non-professional) | Drives UX density and pricing |
| [MARKETS] | US equities + ETFs; options later; crypto/FX/futures out of scope but not precluded | |
| [DATA_PROVIDER_PRIMARY] | Twelve Data Business Venture, OR Tiingo EOD+IEX redistribution + Tiingo fundamentals redistribution | Must carry display/redistribution rights |
| [DATA_PROVIDER_FALLBACK] | The other of the two above; Massive Stocks Business at growth stage | |
| [FUNDAMENTALS_SOURCE] | SEC EDGAR XBRL (free) + provider fundamentals | |
| [MACRO_SOURCE] | FRED + US Treasury (free) | |
| [DATA_LATENCY_MODE] | 15-minute delayed intraday + end-of-day (MVP); real-time later | Real-time adds per-user exchange obligations |
| [STACK] | TypeScript, Next.js (App Router), Postgres on Supabase, Redis (Upstash or equivalent), separate Node worker, SSE for live updates, Vercel + worker host (Fly.io/Railway/Render) | Stack-flexible |
| [CHART_LIB] | TradingView Lightweight Charts (Apache-2.0, attribution required) | |
| [AUTH] | Supabase Auth (email magic link, Google, Apple; TOTP MFA) | |
| [BILLING] | Stripe Billing (subscriptions, trials, proration, Customer Portal) | |
| [EMAIL_PROVIDER] | Resend / Postmark / SES | |
| [LLM_PROVIDER] | Any frontier LLM with tool/function calling | |
| [TIERS] | Free / Pro / Premium | Prices set in Part E |
| [BROKER_LINKING] | Off until Phase 3; SnapTrade read-only | |
| [JURISDICTIONS] | US-first; GDPR/CCPA-ready | |

---

## Part B — The Master Build Prompt

See [`/CLAUDE.md`](../CLAUDE.md).

---

## Part C — Split Into Sequential Phase Prompts

Paste the master prompt once as project context (e.g., a `CLAUDE.md`/`AGENTS.md` file or project instructions). Then send these one at a time, and don't start the next until the acceptance criteria pass.

**Phase 0: Foundations and Data Layer**
> Using the master spec, execute Phase 0 only. Scope:
> - monorepo scaffold (§10), env validation, CI pipeline;
> - Supabase schema for securities, symbol history, corporate actions, prices_daily (partitioned), fundamentals_facts, filings, data_ingestion_runs and provider_health, with RLS scaffolding;
> - `packages/market-data` interface plus the [DATA_PROVIDER_PRIMARY], SEC EDGAR and FRED adapters with recorded-fixture tests;
> - a global SEC rate limiter (≤ 8 req/s, User-Agent);
> - market calendar module;
> - EOD ingestion job (idempotent), corporate-action adjustment, validation rules and staleness monitor;
> - synthetic fixtures for local dev.
>
> No UI beyond an internal admin "data health" page. Plan first and wait for approval.

*Acceptance:*
- 10 years of daily bars for a 500-ticker test universe ingest idempotently (re-running creates zero duplicates);
- split fixtures produce correct adjusted series;
- EDGAR companyfacts ingest for 50 companies without a single 403/429;
- staleness alerts fire in a simulated outage;
- CI is green.

**Phase 1: MVP (public launch candidate)**
> Execute Phase 1:
> - auth (§7), ticker pages (§5.1), charting with indicators (§5.2–5.3);
> - fundamentals viewer (§5.5), screener with saved screens (§5.4);
> - watchlists with SSE updates (§5.9), earnings/economic calendar (§5.7), sector heatmap (§5.8);
> - price and earnings alerts via email (§5.14);
> - basic portfolio tracker (manual + CSV; returns, allocation, benchmark) (§5.10);
> - all compliance components (§12), legal pages, cookie consent;
> - SEO ticker/sector pages with sitemaps;
> - Stripe billing with Free/Pro tiers and entitlements.
>
> Plan first.

*Acceptance:*
- the E2E journey signup → watchlist → alert fires → upgrade → cancel passes;
- Core Web Vitals budgets met on ticker pages;
- every price shows a delay label and source;
- axe reports zero critical issues;
- indicator reference tests pass;
- licensed display verified in DATA_SOURCES.md before the domain goes public.

**Phase 2: Advanced Analytics**
> Execute Phase 2:
> - backtesting engine and UI with disclosures (§5.15);
> - full portfolio risk metrics (§5.10);
> - valuation tools (DCF, multiples, peers) (§5.6);
> - insiders, 13F, short interest (§5.13);
> - news with sentiment (§5.12);
> - indicator/filing alerts;
> - drawing tools;
> - customizable dashboard;
> - PWA + web push;
> - AI features with grounding and evals (§5.16, §9);
> - options analytics only if an options display license is in place (§5.11).
>
> Everything behind feature flags. Plan first.

*Acceptance:*
- backtest golden, look-ahead-canary and survivorship tests pass;
- the AI eval scores 95% or better numeric accuracy with zero uncited numbers;
- the advice red-team scores 100%;
- the portfolio metrics fixture matches within 0.01%.

**Phase 3: Monetization and Scale**
> Execute Phase 3:
> - Premium tier and annual plans, trials/dunning/lifecycle email;
> - referral program;
> - shareable public screens/backtests with embedded disclosures;
> - read-only brokerage linking via SnapTrade (§8);
> - public developer API (only licensed datasets);
> - real-time data tier with non-pro attestation and usage reporting (if licensed);
> - ClickHouse/analytics store evaluation;
> - load testing, DR drill, cost dashboards.
>
> Plan first.

*Acceptance:*
- k6 load targets met;
- restore drill completed within RTO;
- Stripe webhook replay is idempotent;
- broker disconnect deletes synced data;
- the per-vendor cost dashboard is live.

---

## Part D — "Before You Paste This" Checklist

**Decisions:**
- [ ] Brand name, domain and business entity (an LLC or C-corp before signing vendor contracts). Business email on your domain, needed for the SEC User-Agent and vendor agreements.
- [ ] Latency mode: delayed/EOD for MVP (recommended) vs real-time.
- [ ] Primary + fallback data provider, chosen on display rights (see Part E table), not the cheapest API.
- [ ] Tier names, prices and limits.
- [ ] Whether ticker pages are public/crawlable (confirm the license allows it).

**Accounts and keys** (store in a password manager, never in the repo):
- [ ] GitHub (repo, Actions)
- [ ] Vercel
- [ ] Supabase (choose Postgres 17; don't plan on TimescaleDB there)
- [ ] Redis (Upstash or host-provided)
- [ ] Worker host (Fly.io/Railway/Render)
- [ ] Data provider business/display plan (signed terms saved to `/docs/legal`)
- [ ] FRED API key (free)
- [ ] SEC EDGAR (no key; just the User-Agent contact)
- [ ] Stripe (business verification, products/prices, webhook secret, Customer Portal, Stripe Tax decision)
- [ ] Email provider (domain DNS: SPF, DKIM, DMARC)
- [ ] LLM provider key with a spend limit
- [ ] Sentry
- [ ] PostHog (or similar)
- [ ] Cloudflare Turnstile/hCaptcha
- [ ] Domain DNS
- [ ] Later: SnapTrade

**Legal:**
- [ ] 1–2 hour consult with a securities attorney: publisher's exclusion posture, disclaimers, backtest presentation, marketing.
- [ ] ToS/Privacy drafted (attorney-reviewed).
- [ ] Vendor display/attribution requirements recorded.

**Money (monthly, rough):**
- [ ] Data license $250–$700
- [ ] Infrastructure (Vercel, Supabase, Redis, worker, Sentry, email) roughly $100–$300 at MVP. This is an estimate, so check each vendor's current pricing. For the Supabase line, third-party 2026 pricing guides (e.g., flexprice.io) put Pro at "$25 a month," including "$10 a month in compute credits, enough to cover one Micro instance." A Pro project on Large compute comes to about $125/month. I have not checked these figures against Supabase's own pricing page.
- [ ] LLM $50–$500 depending on usage caps
- [ ] Stripe fees (2.9% + 30¢ per card charge plus 0.7% Billing)\[28\]\[29\]

---

## Part E — Recommended Providers, Tools and Pricing (verified September 2026; re-verify before signing)

**Market data: display-rights comparison**

| Provider | Cheap/personal plans | Public-display option | Price for display | Notes |
|---|---|---|---|---|
| **Tiingo** | Free (500 symbols/mo, 50 req/hr, 1,000 req/day); Power $30; Commercial $50 (internal only) | EOD + IEX Display Redistribution; Fundamentals Display Redistribution | $250/mo startups ($500 enterprise); fundamentals $200/mo startups ($500 enterprise) | Cheapest verified display path; real-time via IEX only (single exchange); news redistribution by quote \[7\]\[8\]\[30\] |
| **Twelve Data** | Individual: Basic free (8 credits/min, 800/day), Grow $79, Pro $229, Ultra $999 | Business Venture ("External display data access," real-time US stocks, fundamentals); Enterprise adds "External distribution" | Venture $499/mo ($414/mo annual); Enterprise $1,099/mo | Pricing page table also shows "Venture From $149/mo"; confirm the credit tier you need \[4\]\[5\] |
| **Massive (ex-Polygon)** | Basic $0 (5 calls/min, EOD, 2 yrs); Starter $29 (15-min delayed); Developer $79; Advanced $199 (real-time, non-pros) | Stocks Business (real-time Fair Market Value, 20+ yrs, no exchange fees/approvals) | $2,499/mo; Full Market Delayed expansion $499/mo; Full Market real-time $1,999/mo; startups 25%+ off year one | Individual plans can't be shown to testers; Financials & Ratios $699/mo on Business \[2\]\[3\]\[31\] |
| **Databento** | — | US Equities Mini feed: "free redistribution rights," "no license fees on distribution" | Standard plan announced at $199/mo (Jan 2025); a June 22, 2026 pricing update lists "US Equities: $4,000" (tier unclear) | Mini is a synthetic BBO from a subset of exchanges, not full SIP; verify current price |
| **FMP** | Free (250 calls/day); Starter/Premium/Ultimate personal | Data Display and Licensing Agreement (Build/Enterprise) | Quote only | Personal plans "Individual" usage only \[10\]\[32\] |
| **EODHD** | Free (20 calls/day); personal $19.99–$99.99 | Enterprise (Internal Use $399/mo forbids display) | $2,499/mo | Display inclusion in Enterprise inferred; confirm \[33\]\[34\] |
| **Finnhub** | Free (60 calls/min, personal); paid personal $49.99–$199.99 | Commercial license with written approval | Quote only | Good for personal prototyping \[35\] |
| **Alpaca** | Basic free (IEX real-time); Algo Trader Plus $99 (SIP) | Not for non-brokers: "you cannot redistribute Alpaca API data for business purpose" | n/a | Use only for your own dev/testing |
| **SEC EDGAR / FRED / Treasury** | Free | Public-domain government data | $0 | EDGAR: ≤10 req/s, declared User-Agent |

**Recommended strategy:**
- *MVP:* Tiingo EOD+IEX redistribution ($250) + Tiingo fundamentals redistribution ($200) or EDGAR-only fundamentals ($0), with Twelve Data Venture ($499) as the fallback/alternative. You'll need a fallback license too if you want live failover. Otherwise failover is "serve last-good cached data with a staleness banner."
- *Growth:* Massive Stocks Business ($2,499, or less with the startup discount) for full-market coverage and 20+ years of history, and keep the MVP provider as the fallback.
- Build the abstraction layer from day one so switching is a config change.

**Other tooling (verified points only):**
- **Charts:** TradingView Lightweight Charts (Apache-2.0, attribution + link required). TradingView Advanced Charts is available only to companies with public projects, not for testing, and carries a watermark.\[24\]\[25\]\[36\]
- **Payments:** Stripe cards at 2.9% + 30¢ (domestic) and Stripe Billing at 0.7% of billing volume (pay-as-you-go).\[28\]
- **Brokerage linking (Phase 3):** SnapTrade Build is free (1 user, 5 connections, testing). Launch is $100/month plus $2/connected user (real-time) or $1/connected user (daily, read-only).\[37\]\[38\]
- **Time series:** native Postgres partitioning + pg_partman on Supabase (TimescaleDB deprecated on Postgres 17 there).\[39\]

**Default pricing tiers** (a starting point, benchmarked against TradingView Essential $12.95, Finviz Elite $39.50/mo, Koyfin Plus $39):

| | Free | Pro ($15–20/mo) | Premium ($35–45/mo) |
|---|---|---|---|
| Watchlists / symbols | 2 / 25 | 20 / 200 | Unlimited / 500 |
| Alerts | 5 | 100 | 500 + indicator/filing |
| Financial history | 5 yrs | 10+ yrs | Full + as-reported |
| Screener | Core filters, 3 saved | All filters, 50 saved, export | + technical/ownership filters |
| Backtests | 3/mo, 5 yrs | 50/mo, full history | Unlimited, walk-forward, parameter sweeps |
| AI | 5 queries/day | 50/day | 200/day + filing deep-dives |
| Portfolios | 1 | 5 | Unlimited + broker sync (Phase 3) |

**Rough monthly cost model** (estimates; data costs are verified list prices, infrastructure is an estimate):
- **MVP (≤ 2,000 users):** data $250–$700 + infrastructure $100–$300 + LLM $50–$300, about **$400–$1,300/month**. Break-even is roughly 25–70 Pro subscribers.
- **Growth (10k–50k users):** data $2,500–$4,500 (Massive Business + fallback) + infrastructure $500–$2,000 + LLM $500–$3,000, about **$3,500–$9,500/month**.
- Real-time adds per-user exchange fees (UTP: $1/month per non-professional, $24 per professional) plus reporting overhead.\[15\] Defer until paid demand proves out.

---

## Part F — Phased Build Order, Milestones and Risk Register

| Phase | Duration (solo + AI agent, estimate) | Milestone | Key acceptance criteria |
|---|---|---|---|
| 0 Foundations | 2–4 weeks | Clean, validated data pipeline | Idempotent ingest, adjustment tests, EDGAR compliant, freshness alerts |
| 1 MVP | 6–10 weeks | Public launch (Free + Pro) | E2E journey, CWV budgets, disclaimers everywhere, license confirmed |
| 2 Advanced | 8–12 weeks | Premium feature set | Backtest correctness suite, AI evals ≥95%, portfolio fixture match |
| 3 Scale | Ongoing | Premium tier, broker sync, API | Load/DR tests, billing idempotency, cost dashboards |

**Risk register:**

| Risk | Likelihood / Impact | Mitigation |
|---|---|---|
| Data license violation (displaying personal-plan data) | High / Severe | Business/display license before any tester sees data; DATA_SOURCES.md; server-enforced delay/entitlements |
| Data license cost blowout | Medium / High | Start delayed/EOD; EDGAR for fundamentals; startup discounts (Massive 25%+ off year one); negotiate annual |
| Data accuracy errors | Medium / High | Validation rules, nightly reconciliation, cross-provider spot checks, source+as-of on every number, correction log |
| Provider outage / lock-in | Medium / Medium | Abstraction layer, fallback provider, cached last-good data with staleness banner |
| Regulatory drift into advice | Medium / Severe | Publisher-exclusion rules (§13), AI refusal tests, attorney review before Premium/AI launch |
| Misleading backtests | Medium / High | Point-in-time data, survivorship-free universes, mandatory disclosures, walk-forward |
| AI hallucinated numbers | High / High | Tool-only grounding, numeric verification post-processor, eval gate in CI |
| Scaling / latency | Low early / Medium | Caching, precomputed screener snapshots, SSE fan-out, ClickHouse escalation trigger |
| Scraping of your pages | Medium / Medium | Rate limits, bot protection, no anonymous bulk endpoints |
| Supabase extension changes | Realized (TimescaleDB) | Native partitioning; avoid platform-specific extensions for core data |

## Recommendations

1. **This week:** email Tiingo, Twelve Data and Massive sales. Describe your use case (public website, delayed data, estimated users, whether pages are crawlable) and ask each for written confirmation of display rights, attribution requirements, and whether SEO-indexed public pages and CSV exports are permitted. Ask Massive about the startup discount. Choose on terms, not API ergonomics.
2. **Build Phase 0 on synthetic fixtures and free government data** (EDGAR, FRED) while contracts are in progress. Develop solo using your own personal-plan key, since Massive's terms say even testers trigger Business licensing.\[1\]
3. **Book a securities attorney** before launching paid tiers or the AI features. Bring §12–13 of the prompt as your proposed posture.
4. **Make "every number has a source" your wedge.** Grounded AI plus honest backtests are defensible differentiators against TradingView/Finviz/Koyfin, which compete on breadth you can't match early.

## Caveats

- Provider pricing and terms change often. Every price above was read from vendor pages or vendor-authored material in 2026 and should be re-verified at signing.
- Specific uncertainties:
  - Twelve Data's business page shows both "$499" and "From $149" for Venture.\[5\]
  - Databento's current US equities price is unclear after its June 2026 update.
  - Tiingo's fundamentals redistribution rows show $200 and $100 startup figures on the same page.\[8\]
  - EODHD's display rights under Enterprise are inferred.
  - FMP's and Finnhub's commercial prices are unpublished.
  - Alpaca's community forum hints at future licensing arrangements; that is forward-looking and unconfirmed.\[14\]
- Infrastructure and LLM cost figures are estimates, not quotes. Effort durations are rough estimates for a solo builder using an AI coding agent.
- The legal discussion is informational, not legal advice. The publisher's exclusion depends on facts (impersonal, bona fide, regular circulation).\[40\] Features like personalized "for you" picks, signals-as-instructions, or auto-trading can remove you from it. The SEC Marketing Rule formally binds registered advisers; using it here is a conservative best-practice template, not a stated legal requirement for publishers.\[21\]

## Sources

1. [Which plan do I need to show Massive data in my own app? | Massive](https://massive.com/knowledge-base/article/which-plan-do-i-need-to-show-massive-data-in-my-app)
2. [Pricing](https://massive.com/pricing)
3. [Stocks API for Business | Massive](https://massive.com/business-stocks)
4. [March 2026 updates](https://twelvedata.com/news/march-2026-updates)
5. [Business Pricing - Twelve Data](https://twelvedata.com/pricing-business)
6. [Tiingo API Pricing](https://www.tiingo.com/about/pricing)
7. [Real-time IEX Stock Market Data API](https://www.tiingo.com/products/iex-api)
8. [Fundamental Data API for U.S. Stocks](https://www.tiingo.com/products/fundamental-data-api)
9. [Pricing Plans - Financial Modeling Prep API](https://site.financialmodelingprep.com/pricing-plans)
10. [FMP API Review: Pricing, Free Tier & Limits (2026)](https://www.findmymoat.com/tools/financial-modeling-prep-fmp)
11. [Historical Prices and Fundamental Financial Data API](https://eodhd.com/commercial-pricing)
12. [Finnhub - Free realtime APIs for stock, forex and cryptocurrency.](https://finnhub.io/register)
13. [Alpaca Support - Can I redistribute Alpaca API data via my platform?](https://alpaca.markets/support/redistribute-alpaca-api)
14. [Use SIP data feed for display - Alpaca Market Data - Alpaca Community Forum](https://forum.alpaca.markets/t/use-sip-data-feed-for-display/19641)
15. [UTP Data Policies Published September 2023 Page 1 DATA POLICIES](https://www.utpplan.com/DOC/datapolicies.pdf)
16. [15 Minute Delayed SIP Data API Intrinio](https://intrinio.com/financial-market-data/stock-prices-delayed-sip)
17. [UTP Data Policies Published October 2018 Page 1 DATA POLICIES](https://www.utpplan.com/DOC/DATA_POLICIES_201810_REDLINE.pdf)
18. [LOWE v. SEC, 472 U.S. 181 (1985)](https://caselaw.findlaw.com/court/us-supreme-court/472/181.html)
19. [Lowe v. Securities and Exchange Commission (1985)](https://firstamendment.mtsu.edu/article/lowe-v-securities-and-exchange-commission/)
20. [Lowe v. SEC](https://supreme.justia.com/cases/federal/us/472/181/)
21. [SEC.gov](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/investment-adviser-marketing)
22. [SEC.gov](https://www.sec.gov/newsroom/press-releases/2020-334)
23. [\[Phase 4.4\] Interactive charts with locally served Lightweight Charts · Issue #90 · GHolmesDesigns/algorithmic-crypto-trader](https://github.com/GHolmesDesigns/algorithmic-crypto-trader/issues/90)
24. [Best TradingView Charting Library Alternative - LightningChart](https://lightningchart.com/blog/best-tradingview-charting-library-alternative/)
25. [Free Charting Library by TradingView](https://www.tradingview.com/free-charting-libraries/)
26. [SEC.gov](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
27. [Accessing EDGAR Data](https://www.sec.gov/edgar/searchedgar/accessing-edgar-data.htm)
28. [Pricing & Fees](https://stripe.com/pricing)
29. [Stripe fee calculator: all countries & payment methods - Checkout Page](https://checkoutpage.com/tools/stripe-fee-calculator)
30. [Evaluating Data Coverage with Tiingo](https://www.quantstart.com/articles/evaluating-data-coverage-with-tiingo/)
31. [Stock Market API](https://massive.com/stocks)
32. [How to create a Financial Modeling Prep Account](https://site.financialmodelingprep.com/how-to/how-to-create-a-financial-modeling-prep-account)
33. [EODHD Review: API Pricing, Free Tier & Limits (2026)](https://www.findmymoat.com/tools/eodhd)
34. [Eod Historical Plans Pricing — API Pricing Plans](https://apis.io/plans/eod-historical/eod-historical-plans-pricing/)
35. [Finnhub API - DataGlobeHub](https://dataglobehub.com/api-finder/finnhub-api/)
36. [Web K-line charts lagging? TradingView Lightweight Charts makes financial charts fast and tiny](https://www.x-cmd.com/install/lightweight-charts/)
37. [How to Connect Brokerage Accounts via API for Data and Trading](https://snaptrade.com/how-to-connect-brokerage-accounts-via-api)
38. [Brokerage Integrations](https://snaptrade.com/brokerage-integrations)
39. [64+ PostgreSQL Extensions on Supabase, Ranked (2026)](https://1bench.dev/extensions/postgresql/on-supabase)
40. [No Need for Seeking Alpha to Seek Registration](https://www.gtlaw.com/en/insights/2024/8/no-need-for-seeking-alpha-to-seek-registration)
