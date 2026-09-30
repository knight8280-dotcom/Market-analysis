/**
 * Compliance copy registry (spec §12). Every disclaimer and label is defined once here so pages
 * cannot drift from the approved wording. Phase 1 adds the global footer, delay labels and the
 * other §12 texts.
 */
export const COPY = {
  sampleDataBanner:
    "SAMPLE DATA: this environment shows synthetic test data (TEST_ tickers). It is not real market data.",
  staleDataBanner: (dataset: string, since: string) =>
    `${dataset} data may be stale: its freshness check has been failing since ${since}.`,
} as const;
