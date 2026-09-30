import { formatDate } from "@market/ui";

/**
 * Compliance copy registry (spec §12). Every disclaimer and label is defined once here so pages
 * cannot drift from the approved wording.
 */
export type DelayKind = "eod" | "delayed" | "realtime" | "filing" | "observation";

export const COPY = {
  sampleDataBanner:
    "SAMPLE DATA: this environment shows synthetic test data (TEST_ tickers). It is not real market data.",
  staleDataBanner: (dataset: string, since: string) =>
    `${dataset} data may be stale: its freshness check has been failing since ${since}.`,
  /** §12 global footer, verbatim with the brand filled in. */
  footer: (brand: string) =>
    `${brand} provides financial data and analytics for informational and educational purposes only. Nothing on this site is investment, tax, or legal advice, or a recommendation or offer to buy or sell any security. Investing involves risk, including loss of principal. Data may be delayed or contain errors; verify before acting. ${brand} is not a registered broker-dealer or investment adviser.`,
  /** §12 delay labels, shown next to every price. */
  delay: (kind: DelayKind, asOf?: string | null): string => {
    switch (kind) {
      case "eod":
        return `End-of-day, as of ${formatDate(asOf)}`;
      case "delayed":
        return "Delayed 15 min";
      case "realtime":
        return "Real-time";
      case "filing":
        return `As filed, ${formatDate(asOf)}`;
      case "observation":
        return `As of ${formatDate(asOf)}`;
    }
  },
  source: (name: string) => `Source: ${name}`,
  personalUse: "Personal use only. Licensed for the owner's own screen.",
} as const;
