# Recorded EDGAR responses (trimmed)

Live responses fetched 2026-09-30 with the project's declared User-Agent, then trimmed:
the first rows of `filings.recent` plus Apple's FY2025 10-K row, and the last three facts of a
few concepts; and three statement pages (R3 income, R5 balance sheet, R8 cash flow) of Apple's FY2025 10-K with its FilingSummary.xml, cut to the statement table. SEC EDGAR data is public domain, so recordings may be committed (unlike
commercial vendor data). They pin the adapter to the real response shape.

## form4/

Thirteen Form 4 ownership documents (the raw XML behind each filing's primary document), recorded
verbatim on 2026-10-02 and named by accession number:

| Accession                                                | Issuer        | Covers                                                                                              |
| -------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 0001140361-26-038307                                     | Apple         | sale under a Rule 10b5-1 plan (footnote), `true`/`false` flags                                      |
| 0000050863-26-000177                                     | Intel         | open-market purchase (P) held indirectly, holdings-only lines                                       |
| 0000050863-26-000174                                     | Intel         | RSUs vesting (M, F) in both tables, prices given only as footnotes                                  |
| 0001910388-26-000007                                     | Goldman Sachs | three sales at weighted-average prices, each with its footnote                                      |
| 0001921955-26-000012                                     | Target        | 4/A amendment with its original filing date, fractional units                                       |
| 0000034088-26-000039                                     | Exxon Mobil   | the older X0508 schema                                                                              |
| 0000034088-26-000085                                     | Exxon Mobil   | exit filing: no transactions, "no longer subject to Section 16"                                     |
| 0000886982-26-000310                                     | Old QVC Group | listed under Goldman Sachs as reporting owner: the issuer is another company                        |
| 0001140361-26-038022, -038024, -038026, -038027, -038028 | Apple         | RSU awards (A) in Table II; the five Form 4s at the top of `submissions-CIK0000320193.trimmed.json` |
