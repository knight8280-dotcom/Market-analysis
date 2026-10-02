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
  /** Lightweight Charts NOTICE (Apache-2.0), shown with a link to tradingview.com (§12). */
  chartAttribution: "TradingView Lightweight Charts™. Copyright (с) 2025 TradingView, Inc.",
  chartAttributionUrl: "https://www.tradingview.com/",
  adjusted: (adjusted: boolean) =>
    adjusted ? "Adjusted for splits and dividends" : "As traded (not adjusted)",
  /** §12 backtest disclosure, verbatim, shown above results. */
  backtestDisclosure: (a: { commissions: string; slippage: string; fills: string }) =>
    `Hypothetical results. These results are based on a simulated backtest using historical data and the assumptions shown (commissions ${a.commissions}, slippage ${a.slippage}, fills at ${a.fills}). They do not represent actual trading, may not reflect the impact of market factors such as liquidity, and benefit from hindsight. Past performance, actual or hypothetical, does not guarantee future results. This tool does not recommend any strategy.`,
  /** The same disclosure for a list of runs, each with its own assumptions. */
  backtestListDisclosure:
    "Hypothetical results. These results are based on simulated backtests using historical data and the assumptions shown on each run's page (commissions, slippage, fills). They do not represent actual trading, may not reflect the impact of market factors such as liquidity, and benefit from hindsight. Past performance, actual or hypothetical, does not guarantee future results. This tool does not recommend any strategy.",
  /** §5.6 required copy, above the DCF calculator. */
  valuationCalculator:
    "This model is a calculator driven by your assumptions. It is not a price target or recommendation.",
  /** §12 valuation tools label, next to the model's outputs. */
  valuationOutput: "Model output depends entirely on your inputs. It is not a price target.",
  /** Above a sweep's best combination: it was picked with hindsight. */
  sweepBest: (combinations: number, objective: string) =>
    `Best of ${combinations} parameter combinations by ${objective}, picked with hindsight on the same data. A choice made this way usually does worse on data it was not picked on; see a walk-forward run for an out-of-sample record.`,
} as const;
