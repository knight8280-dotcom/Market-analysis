# Compliance

Informational, not legal advice. The owner consults a securities attorney before launching paid or advisory-like features (spec §13). This file tracks per-provider obligations and how the code enforces the spec's rules.

## Per-provider checklist

| Provider    | Display                                       | Attribution                                                                                                                | Caching / storage                       | Export      | Derived data                                                   | Status                                                   |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Synthetic   | non-production only, with SAMPLE DATA banner  | "SAMPLE DATA: synthetic, not real market data"                                                                             | n/a                                     | no          | n/a                                                            | enforced in code                                         |
| Tiingo      | **not until contracted**                      | TBD by contract (placeholder "Data provided by Tiingo")                                                                    | TBD (ask)                               | TBD (ask)   | TBD (ask: our adjusted series are derived from their raw data) | ✗ contract pending                                       |
| Twelve Data | not until contracted                          | TBD                                                                                                                        | TBD                                     | TBD         | TBD                                                            | ✗ not selected                                           |
| Massive     | not until contracted                          | TBD                                                                                                                        | TBD                                     | TBD         | TBD                                                            | ✗ growth stage                                           |
| SEC EDGAR   | yes (public domain)                           | "Source: SEC EDGAR" (courtesy, not required)                                                                               | allowed; fair-access limits on fetching | allowed     | allowed                                                        | ✓ limiter + User-Agent in code; live run pending contact |
| FRED        | yes, for series without third-party copyright | **required**: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." | the terms are silent on storage         | not planned | allowed for public-domain series                               | ✓ notice stored; copyrighted series refused              |
| Treasury    | yes (public domain)                           | "Source: U.S. Department of the Treasury"                                                                                  | allowed                                 | allowed     | allowed                                                        | adapter not built                                        |

**Questions for each commercial vendor before signing:**

- May SEO-indexed public pages show the data, or only logged-in users?
- Is CSV export allowed?
- Is derived data (adjusted series, indicators, screeners) allowed?
- What caching and retention terms apply?
- What exact attribution text or logo is required, and where?
- What delay applies?
- What does the exchange fee structure look like for delayed display (UTP external delayed redistributor fee)?

## Spec rules and where they are enforced

| Rule                                                                | Enforcement                                                                                                                                                             | Test                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Never fabricate or fill in data (MUST-NOT #1)                       | the validator rejects or flags and never repairs; FRED `"."` → NULL; missing dividend prior close → factor not applied, issue recorded; synthetic halts produce no bars | `validation.test.ts`, `adjustments.test.ts`, `fred.test.ts`, `synthetic.test.ts` |
| Never present sample data as real (MUST-NOT #2, rule 6)             | env refuses the synthetic provider in production; `license_tier: synthetic` on every record; `TEST_` tickers; SAMPLE DATA banner                                        | `env.test.ts`, `banner.test.tsx`, `licenses.test.ts`                             |
| No hard-coded secrets (MUST-NOT #3)                                 | zod env module; `.env.example` placeholders; gitleaks in CI and pre-commit; secrets redacted from errors and logs; API keys never in URLs we log                        | `env.test.ts`, `http.test.ts`, `fred.test.ts`                                    |
| No provider calls from the browser (MUST-NOT #4)                    | adapters live in the worker; the web app reads only our database; private schemas unreachable by client roles                                                           | `security.int.test.ts`                                                           |
| No real-time to non-entitled users (MUST-NOT #6, §2.2)              | `enforceDelay()`; uncontracted providers not displayable                                                                                                                | `licenses.test.ts`                                                               |
| Don't disable security controls (MUST-NOT #8)                       | RLS on every table; the audit fails CI otherwise                                                                                                                        | `security.int.test.ts`                                                           |
| Reversible, tested migrations (MUST-NOT #9)                         | rollback scripts; CI round trip with schema fingerprint                                                                                                                 | `pnpm db:roundtrip`                                                              |
| Source and as-of on every data point (rule 7)                       | provenance fields required on every canonical record                                                                                                                    | `types` via adapters' zod parsing                                                |
| SEC fair access (§2.3)                                              | shared 8 req/s limiter, fail closed, declared User-Agent                                                                                                                | `rate-limit.int.test.ts`, `sec-edgar.test.ts`                                    |
| Licensed display confirmed before going public (Phase 1 acceptance) | `DATA_SOURCES.md` status column                                                                                                                                         | manual                                                                           |

## Owner actions outstanding

1. Choose a brand and domain, and set up a business email. This unblocks the SEC User-Agent and the live EDGAR acceptance run.
2. Get written display terms from Tiingo (and a fallback vendor if live failover is wanted). Save them to `docs/legal/` in a private location.
3. Book a securities attorney before Phase 1 launches publicly (publisher's exclusion posture, disclaimers, backtest presentation).
