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

## Feature switches

- `/settings` lists the features that ship behind a switch (ADR-024). "Turn off" hides a feature's pages and menu entry and keeps its data; "Use default" removes your override. Overrides are rows in `ops.feature_flags`.
- Switches after Phase 2a, all on by default: Backtests, Portfolio risk (the risk panel and allocation by asset class; returns and holdings stay), Valuation, More alert types, Notifications, Chart drawings and Customizable dashboard (off shows the standard layout). Phase 2b adds Ownership (the Ownership tab and insider-purchase alerts) and News.

## Alerts

- Alerts are checked within seconds of new data: after each end-of-day load (price, RSI, moving-average and volume alerts on those stocks), after a filings refresh stores new filings, and after the screener is rebuilt. At 18:50 ET the worker checks every alert again (and earnings dates). To run now: `pnpm worker alerts` (prints what fired and what was emailed). Re-running is safe: nothing fires twice for the same bar, filing or change of results.
- Links in alert emails ("Manage this alert") point to `APP_BASE_URL` (default `http://localhost:3000`). Set it to the address you open the app at, for example your Tailscale HTTPS address once phone access is set up.
- **Email setup** (optional; without it events are listed on `/alerts` as "Not emailed"): create a free Resend account with your own address, create an API key, and set `RESEND_API_KEY` and `ALERT_EMAIL_TO` (that same address) in `.env`. The default sender, `onboarding@resend.dev`, delivers only to the account's own address, which is all personal use needs. `ALERT_DAILY_CAP` (default 20) limits emails per day; the rest are recorded as suppressed.
- **A failed email** (status "Failed" with Resend's error) is retried by the job's own retries; if it keeps failing, check the key and address, then run `pnpm worker alerts` again. Failed events older than a day are not retried.
- To check delivery end to end without Resend, point `RESEND_API_URL` at a local capture server (the E2E test does this).
- **Notifications:** every alert that fires also appears under the bell in the header (`/notifications`); opening the page marks them read. Each one can snooze its alert (1 day, 3 days or a week), pause it, delete it (with its notifications), or be dismissed on its own. Each alert has a page (`/alerts/<id>`, also linked from emails) with its state and what it fired. A snoozed filing or screen alert reports what it held back once the snooze ends; price and indicator crossings during a snooze are not replayed.
- **More alert types** (RSI, moving averages, volume, filings, screens) and **Notifications** can be switched off on `/settings`; while "More alert types" is off, those alerts are not checked.
- **Insider purchases** ("Insider buys on the open market", also from "Alert on insider purchases" on a ticker's Ownership tab): fires when a Form 4 reports an open-market purchase worth at least the amount you set at the filed prices (0 for any). It is checked as soon as the evening EDGAR refresh reads the Form 4, so it needs EDGAR (see Insider transactions below). It reports only filings accepted after the alert was created, and needs a security with a CIK (ETFs and funds have none). Turning off "Ownership" or "More alert types" stops it.

## Portfolio

- `/portfolio`: create a portfolio (benchmark ticker defaults to SPY), then add transactions by hand or import a CSV. Returns, allocation and dividends are calculated on each page load from the entries and end-of-day closes (ADR-023).
- **CSV format:** `date,type,ticker,quantity,price,amount,fees,notes` (download the template from the page). Types: buy, sell, dividend, deposit, withdrawal, fee. Quantities and prices as traded; splits are applied automatically. Buys without deposits are fine: cash shortfalls count as deposits.
- **Imports are all or nothing.** Fix the lines listed and import the file again; nothing is stored until every line passes (including "sells more than held").
- If a holding shows "valued at cost", its prices are not loaded (add the ticker to `config/universe.json` and backfill).
- **Risk panel:** volatility, beta, correlation, drawdown length, concentration and daily P&L need only prices; Sharpe and Sortino also need T-bill rates (FRED `DTB3`, loaded when `FRED_ENABLED` is set) and show "No T-bill rates stored" until then. Each measure's method is in the ⓘ next to it. The holdings' correlation table needs two or more holdings with a few weeks of prices.
- Regenerate the reference fixture after changing a convention: `python3 packages/portfolio/scripts/make_fixture.py`, then `pnpm --filter @market/portfolio test`.

## Backtests

- `/backtests` → "New backtest": pick an example or build rules, set costs, choose a single run (optional out-of-sample split date), a parameter sweep or a walk-forward, and run. Type `$name` in a number field to make it a parameter. The JSON view edits the whole request, nested rule groups included.
- **Runs need the worker.** The page shows "Waiting for the worker…" until it picks the run up (within 3 seconds while `pnpm --filter @market/worker start` runs). Without the long-running worker, run queued backtests once with `pnpm worker backtests`; `pnpm worker backtest --run <id>` re-runs one in place.
- Each run executes in a worker thread with a 10-minute limit (ADR-025). A run that hits it fails with "ran past its time limit": narrow the universe, the period or the number of combinations. A run left "running" after the worker stopped is marked failed on the next start; use "Run again".
- **Reproducibility:** every finished run shows its code version and data fingerprint. "Run again" queues the same request; its page says whether earlier runs of that request saw the same data. A different fingerprint means prices were added or corrected in between.
- Ranking a sweep by Sharpe ratio needs T-bill rates (FRED `DTB3`, ingested when `FRED_ENABLED` is set); without them the builder ranks by CAGR.
- `/settings` can turn Backtests off; runs and strategies are kept.

## Dashboard

- "Customize" on the Markets page arranges it: each widget can move up or down, be full or half width, or be hidden (hidden ones are listed at the top to show again); on a desktop a widget can also be dragged by its handle onto another. Changes save as you make them; "Reset layout" returns to the standard one and "Done" leaves editing.
- The screen widget shows the first saved screen by name, or the one picked while customizing.
- "Customizable dashboard" can be switched off on `/settings`; the standard layout then shows.

## Chart drawings

- On a ticker's chart, pick a tool (trend line, horizontal line, Fibonacci retracement, rectangle, text) and click the chart: one click for a horizontal line or text, two for the others. Escape or "Stop drawing" puts the pen down. "Drawings" under the chart lists them in words, deletes them, and adds one from typed dates and prices.
- Drawings belong to the price basis they were drawn on: one made with "Adjusted" ticked shows only on the adjusted chart.
- "Chart drawings" can be switched off on `/settings`; the drawings stay stored.

## Valuation

- A ticker's **Valuation** tab: the DCF calculator starts from the latest filings where they exist (each input says where it came from) and from labelled assumptions for the rest; edit anything and the outputs and the sensitivity grid update at once. "Save these inputs" stores a scenario per security; "Load" puts it back.
- **Peers** share the SEC industry code (stored when filings are ingested from EDGAR submissions, e.g. `pnpm worker edgar --tickers AAPL`) and are the closest eight by market cap. Type tickers into "Peer tickers" to compare with your own list. A dash means a figure is missing or not positive; nothing is estimated.
- The **five-year history** needs prices and filings; it uses figures as first reported, known by each month end.
- `/settings` can turn Valuation off; saved scenarios are kept.

## Insider transactions (Form 4)

- Needs EDGAR (`EDGAR_ENABLED=true`, `APP_NAME`, `SEC_CONTACT_EMAIL`). New Form 4s are read automatically: the evening filings refresh (21:00 ET) queues each one filed in the last 30 days, and a sweep at 22:30 ET picks up any it missed. Each is one SEC request through the shared limiter.
- **History, once:** `pnpm worker insiders --days 730` reads every stored Form 4 from the last two years that has not been read (about 15,000 requests for 50 large companies, roughly half an hour). `--tickers AAPL,MSFT` limits it; `--limit 500` caps one run. It prints how many were read, any it could not read, and SEC's HTTP status counts.
- **Unreadable filings** (no XML, or a document the parser refuses) are listed in `market.insider_filing_errors` with the reason and are not fetched again until the parser version changes (`INSIDER_PARSER_VERSION` in `apps/worker/src/jobs/insiders.ts`). After fixing the parser, raise the version and run the history command again: it reads them, and re-reads stored filings, at the new version.
- A Form 4 about another company (for example one Goldman Sachs filed as a large holder elsewhere) is stored under that company's CIK and shown only there.

## Institutional holdings (13F)

- Needs EDGAR (as above). At 23:00 ET the worker checks SEC's 13F listing and reads the two newest data sets when either is new (about 100 MB each, roughly 25 seconds to read). Data sets cover three months of filing dates: the June–August set holds the 30 June quarter.
- **On demand:** `pnpm worker 13f` (add `--latest 3` for one more quarter, `--names <file>` for a particular set, `--force` to read stored sets again). It first refreshes CUSIPs from SEC's fails-to-deliver files if they are more than a week old; `pnpm worker cusips` does only that.
- **A listing with no 13F holders** has no CUSIP. Check the data-health page or `ops.data_quality_issues` for `cusip_name_mismatch`: SEC's files gave its ticker a name that does not agree with ours (GE is listed by SEC as "GE AEROSPACE"). Correcting the listing's name in `market.securities` and running `pnpm worker cusips` fixes it if the names then agree.
- Eight quarter ends are kept; older ones are dropped when a newer data set is read.

## Short interest (FINRA)

- **Credential (free, once):** on developer.finra.org choose Console, then "Create Account Here" to open an individual API account. In the API Console request a **Public** credential and accept FINRA's API Terms of Service; FINRA emails a link to set the client secret (it expires in 24 hours). Put the client ID and secret in `.env` as `FINRA_API_CLIENT_ID` and `FINRA_API_CLIENT_SECRET`. Personal, non-commercial use only.
- **First run:** `pnpm worker short-interest` reads about a year of settlement dates for your listings and prints what it stored and any ticker whose FINRA name does not agree with yours. Then the worker checks daily at 19:30 ET (FINRA publishes about a week after each mid-month and month-end settlement date).
- **First live run checks the adapter:** the token exchange and query format follow FINRA's documentation and have not yet been tried with a real credential. If the run fails with a response-shape or HTTP 400 error, keep the output (it names the field or status, never the secret) and fix the adapter (`packages/market-data/src/adapters/finra.ts`). Do not commit FINRA responses.
- Days to cover is FINRA's own figure (short interest ÷ average daily volume). It is left empty when average volume is zero, where FINRA prints 999.99.

## News

- A ticker's **News** tab lists the last 90 days: press releases the company filed with SEC (Exhibit 99 to Form 8-K) and, with a Finnhub key, company news. Each item shows its source, outlet, time and a link out; a story carried by several outlets appears once, with the others under "Also". "Press releases" and "News" filter the list.
- **Press releases** need EDGAR (as above). The evening filings refresh reads the press release of each new 8-K with exhibits (two SEC requests), and a sweep at 22:45 ET catches any it missed. History: `pnpm worker press-releases --days 365` (`--tickers AAPL,MSFT`, `--limit 500`); it prints how many 8-Ks had a release and how many had none.
- **An item in italics** is an exhibit without a headline the reader could take (a slide deck, a shareholder letter, tables): it says what was filed instead. If a real release shows this way, its layout is new to the reader: record it as a fixture (`packages/market-data/scripts/record-press-releases.ts`), fix the reader, raise `PRESS_READER_VERSION` in `apps/worker/src/jobs/news.ts` and run the history command to read stored 8-Ks again.
- **Company news** needs `FINNHUB_API_KEY` (the same free key as the earnings calendar). The worker reads it at 07:00 and 17:00 ET; `pnpm worker news` reads it now (`--tickers`, `--from`, `--to`). The first run reaches back 30 days. **Before relying on it, check the shape once with the real key:** if the run fails with a response-shape error, keep the output (it never includes the key) and fix `packages/market-data/src/adapters/finnhub.ts`. Never commit Finnhub responses.
- Articles left out (no headline, a link that is not a web page, an impossible time) are listed on the data-health page as `news_item_skipped`.
- News older than about 13 months is deleted at 03:30 ET. **If you give up the Finnhub key,** Finnhub's terms ask for its data to be deleted: `delete from market.news_articles where source = 'finnhub'; delete from market.earnings_events where source = 'finnhub';`.
- "News" can be switched off on `/settings`; the data stays stored and is still read.

## AI: news sentiment

- **Key (optional, owner's own):** create an API key in the Claude Console (platform.claude.com) and set `ANTHROPIC_API_KEY` in `.env`. `AI_MONTHLY_BUDGET_USD` (default 10) caps spending per calendar month (UTC); `AI_SENTIMENT_MODEL` defaults to Claude Haiku 4.5, the least expensive model.
- With the key, the worker rates new stories at 07:30, 17:30 and 23:30 ET; `pnpm worker sentiment` does it now (`--days 30`, `--limit 200`) and prints what it rated, rejected and spent. Expect a few cents a month.
- **Spending:** every request is in `ops.ai_requests` with its tokens and cost (kept 90 days). This month so far: `select sum(cost_usd) from ops.ai_requests where created_at >= date_trunc('month', now() at time zone 'utc');`. When a request could pass the monthly cap, nothing more is sent until next month and the run says `stoppedBy: "budget"`; raise `AI_MONTHLY_BUDGET_USD` if you want more.
- **Changing the model or the prompt** (`SENTIMENT_PROMPT_VERSION` in `packages/ai/src/sentiment.ts`) rates the last 30 days again with the new one. A model without a price in `packages/ai/src/pricing.ts` is refused: add its price from Anthropic's pricing page first.
- **Rejected answers** (a reply that is not JSON, or a label that contradicts its score) leave the story unrated; the next run asks again. Many rejections mean the model or prompt needs a look.

## Ownership tab

- A ticker's **Ownership** tab shows the three datasets above: Form 4 transactions from the last 12 months with 90-day purchase and sale totals and purchase clusters, 13F positions by quarter end (pick a quarter above the table) with changes from the quarter before, and short interest by settlement date. Every section names its source and date; each Form 4 line and 13F position links to its filing on SEC EDGAR.
- **An empty section** says why: no CIK (ETFs and funds), no Form 4 read yet (`pnpm worker insiders`), no CUSIP for the listing or no data set read yet (`pnpm worker 13f`; see Institutional holdings above), or no FINRA credential (see Short interest above).
- Changes in 13F positions appear only when the quarter just before is loaded; a fresh install with one data set shows positions without changes until the next set is read.
- "Ownership" can be switched off on `/settings`; the data stays stored and is still read.

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
