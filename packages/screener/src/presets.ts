import type { Screen } from "./schema";

/**
 * Starting points for the screener. These are filters, not recommendations: each one only
 * describes a condition, and the page says so (publisher's exclusion, spec §13).
 */
export const PRESETS: { id: string; name: string; description: string; screen: Screen }[] = [
  {
    id: "above-sma200",
    name: "Above the 200-day average",
    description: "Price above its 200-day simple moving average.",
    screen: {
      conditions: [{ field: "close", op: "gt", ref: "sma200" }],
      sort: { field: "pct_from_sma200", dir: "desc" },
    },
  },
  {
    id: "rsi-below-30",
    name: "RSI below 30",
    description: "14-day RSI under 30.",
    screen: {
      conditions: [{ field: "rsi14", op: "lt", value: 30 }],
      sort: { field: "rsi14", dir: "asc" },
    },
  },
  {
    id: "near-52w-high",
    name: "Within 2% of the 52-week high",
    description: "Price no more than 2% below its 52-week high.",
    screen: {
      conditions: [{ field: "pct_from_high_52w", op: "gte", value: -0.02 }],
      sort: { field: "pct_from_high_52w", dir: "desc" },
    },
  },
  {
    id: "low-pe-dividend",
    name: "P/E under 15 with a 3%+ yield",
    description: "Positive trailing earnings, P/E below 15, dividend yield of 3% or more.",
    screen: {
      conditions: [
        { field: "pe", op: "between", value: [0, 15] },
        { field: "dividend_yield", op: "gte", value: 0.03 },
      ],
      sort: { field: "dividend_yield", dir: "desc" },
    },
  },
  {
    id: "large-caps",
    name: "Market cap over $100 billion",
    description: "The largest companies by market value.",
    screen: {
      conditions: [{ field: "market_cap", op: "gte", value: 100e9 }],
      sort: { field: "market_cap", dir: "desc" },
    },
  },
  {
    id: "six-month-leaders",
    name: "Up 20%+ over 6 months, above the 50-day",
    description: "Six-month total return above 20% and price above its 50-day average.",
    screen: {
      conditions: [
        { field: "return_6m", op: "gt", value: 0.2 },
        { field: "close", op: "gt", ref: "sma50" },
      ],
      sort: { field: "return_6m", dir: "desc" },
    },
  },
  {
    id: "big-moves-today",
    name: "Up 5%+ today",
    description: "Change on the latest session of 5% or more.",
    screen: {
      conditions: [{ field: "change_1d", op: "gte", value: 0.05 }],
      sort: { field: "change_1d", dir: "desc" },
    },
  },
];
