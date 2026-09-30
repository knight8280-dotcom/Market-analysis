# Data Sources

For each provider: plan, license type, what we may do with the data, the date terms were last verified, and the terms URL (spec §2.2). The machine-readable counterpart is `DATA_LICENSES` in `packages/market-data/src/licenses.ts`; update both together.

**Personal use only (owner decision, 2026-09-30).** Nothing from this system is shown to anyone other than the owner, so personal data plans are sufficient and no display contract is needed. Two rules follow:

- personal-plan data must never reach a public URL or another person's screen, including testers;
- if the system is ever shared or published, every commercial row below needs a display/redistribution license first (Massive states this explicitly; the other vendors' personal plans are the same in substance).

Research behind these rows: `docs/BRIEF.md`.

## Summary

| Provider                   | Status                                                  | License tier    | Display                                         | Datasets                                  | Verified   | Terms                                                                           |
| -------------------------- | ------------------------------------------------------- | --------------- | ----------------------------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Synthetic (`synthetic`)    | generated test data                                     | `synthetic`     | non-production only, with SAMPLE DATA banner    | securities, daily bars, corporate actions | n/a        | n/a                                                                             |
| Tiingo (`tiingo`)          | **personal plan, owner only** (key not yet provided)    | `personal_dev`  | owner only (`DATA_LICENSES` audience `owner`)   | daily bars, corporate actions, securities | —          | https://www.tiingo.com/about/pricing                                            |
| Finnhub (`finnhub`)        | **personal plan, owner only**; optional, no adapter yet | `personal_dev`  | owner only                                      | earnings calendar (Phase 1 H1)            | —          | https://finnhub.io/pricing                                                      |
| Twelve Data (`twelvedata`) | not contracted, no adapter yet                          | `personal_dev`  | no                                              | —                                         | —          | https://twelvedata.com/pricing-business                                         |
| Massive (`massive`)        | not contracted, no adapter yet                          | `personal_dev`  | no                                              | —                                         | —          | https://massive.com/business-stocks                                             |
| SEC EDGAR (`sec_edgar`)    | public                                                  | `public_domain` | yes                                             | fundamentals, filings                     | 2026-09-30 | https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data |
| FRED (`fred`)              | public API (free key)                                   | `public_domain` | yes (series without third-party copyright only) | macro                                     | 2026-09-30 | https://fred.stlouisfed.org/docs/api/terms_of_use.html                          |
| U.S. Treasury (`treasury`) | public, no adapter yet                                  | `public_domain` | yes                                             | macro                                     | —          | —                                                                               |

## Provider notes

### Tiingo (primary for prices)

- **Plan:** the free personal plan (ADR-015). Quotas used by the limiter, from the project brief: 50 requests/hour, 1,000/day, 500 unique symbols/month. Confirm them on the pricing page when the key is created, and set `TIINGO_HOURLY_LIMIT`/`TIINGO_DAILY_LIMIT` for a paid personal plan (Power).
- **Pacing:** both quotas are sliding windows in Redis (`ratelimit:tiingo:hour`, `ratelimit:tiingo:day`), shared by the worker and the CLI. A job waits up to 65 minutes for a slot instead of failing. One symbol costs two requests on first load (meta + prices; bars and corporate actions share the prices request), so a 65-symbol bootstrap takes about 2 hours 40 minutes on the free tier.
- **Display redistribution** (needed only if the system is ever shared): EOD + IEX redistribution ($250/month startup) and, optionally, fundamentals ($200/month startup). The questions to ask Tiingo before that are in `docs/BRIEF.md`.
- **Adapter status: SHAPE UNVERIFIED.**
  - The price fields (`date, open, high, low, close, volume, adjOpen…adjVolume, divCash, splitFactor`) and meta fields (`ticker, name, exchangeCode, description, startDate, endDate`) come from Tiingo's public documentation, checked 2026-09-30.
  - The `Authorization: Token <key>` header is not shown on the public page and is unverified.
  - The fixtures (`packages/market-data/test/fixtures/tiingo`) hold synthetic values.
  - To verify: make one request per endpoint with a personal key, compare field names and types with the fixtures, and record the result and date here. **Do not commit the response.**
- **Asset class:** the meta endpoint does not report it, so `TiingoProvider` refuses securities whose asset class is not configured. The universe file (`config/universe.json`, ADR-017) supplies it for every symbol the worker loads.

### SEC EDGAR

- **CIKs for securities:** `attach-edgar-ids` matches equities without a CIK to `company_tickers_exchange.json` by ticker (`BRK.B` = `BRK-B`). Synthetic securities never get one. Unmatched tickers are logged, not guessed.
- **Fair-access policy** (≤ 10 requests/second, declared User-Agent in the form `Sample Company Name AdminContact@<domain>.com`). We run at ≤ 8 requests/second across all processes through the Redis limiter, and retry 403/429/503 with backoff.
- **Endpoints used:**
  - `https://www.sec.gov/files/company_tickers_exchange.json`
  - `https://data.sec.gov/submissions/CIK##########.json` (recent filings only; older pages and `submissions.zip` are the Phase 1 bulk path). The same response gives the registrant's SIC code, which sets `sic_code`, `industry` and `sector` (ADR-016).
  - `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`
- **Fixtures:**
  - hand-built cases with made-up values (registrant CIK 0000000042);
  - trimmed **live recordings** from 2026-09-30 (`test/fixtures/sec-edgar/recorded/`): Apple submissions and companyfacts, a numeric-string CIK (ExxonMobil Holdings Corp) and `fy: 0`/`fp: ""` facts (Wells Fargo). SEC data is public domain, so recordings may be committed.
- **Response shape verified 2026-09-30** on the live run.
- **`acceptanceDateTime` is true UTC** (verified 2026-09-30). Apple's FY2025 10-K shows `2025-10-31T10:01:26.000Z` in the JSON and "Accepted 2025-10-31 06:01:26" (Eastern) on its index page.
- **Live acceptance run done 2026-09-30:** 50 companies, 101 requests, all HTTP 200, 1,461,821 facts and 119,717 filings. The User-Agent is `Market Analysis <owner email>`; the email is set only in env and never committed.

### FRED

- **Required notice, verbatim** (FRED API Terms of Use, checked 2026-09-30): "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." It is stored as FRED's attribution in `DATA_LICENSES`.
- **Third-party copyrighted series** (notes containing "Copyright") need the owner's permission. `FredProvider` refuses them with `LicenseRestrictedError`.
- **Default series:** `DGS3MO`, `DGS2`, `DGS10`, `FEDFUNDS`, `CPIAUCSL`, `UNRATE`, `GDP`. These come from the Federal Reserve Board, BLS and BEA and are public domain. Check the notes of any series before adding it.
- **Missing observations** (`"."`) are stored as NULL and never zero-filled.
- **Fixtures** are hand-built in the documented shape with illustrative values.

### Synthetic

`SyntheticProvider` generates 500 `TEST_` securities from 2016-01-04 with the scenario catalogue listed in `ARCHITECTURE.md`. It is deterministic by seed. The worker env refuses it in production, and the web app shows the SAMPLE DATA banner wherever synthetic mappings exist.

## Adding a provider

1. Get signed display/redistribution terms and save them to `docs/legal/` (not yet created; keep contracts out of public repos).
2. Add the provider id to `market.data_providers` in a migration, and to `PROVIDER_IDS`.
3. Add a `DATA_LICENSES` entry and a row here, with the plan, verification date and terms URL.
4. Write the adapter against documented shapes, with synthetic-valued fixtures. Mark it "shape unverified" until a live comparison is done.
5. Update `COMPLIANCE.md` (attribution, caching, export, derived data).
