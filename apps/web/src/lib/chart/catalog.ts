import {
  atr,
  bollinger,
  cci,
  directionalMovement,
  donchian,
  ema,
  keltner,
  macd,
  obv,
  relativeStrength,
  rollingVolatility,
  rsi,
  sma,
  stochastic,
  vwap,
  williamsR,
  type Series,
} from "@market/indicators";

/**
 * The chart's indicator menu. Pure data and functions (no DOM), so the same code runs on the
 * main thread and in the Web Worker.
 */

export interface ChartBars {
  time: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/** Okabe–Ito palette: distinguishable with the common color-vision deficiencies. */
export const PALETTE = {
  orange: "#E69F00",
  sky: "#56B4E9",
  green: "#009E73",
  yellow: "#F0E442",
  blue: "#0072B2",
  vermillion: "#D55E00",
  purple: "#CC79A7",
  grey: "#999999",
} as const;

export interface LineSpec {
  key: string;
  label: string;
  color: string;
  style?: "line" | "histogram" | "dashed";
}

export interface IndicatorDef {
  id: string;
  label: string;
  /** "overlay" draws on the price pane; "pane" gets its own pane below. */
  placement: "overlay" | "pane";
  lines: LineSpec[];
  /** Horizontal guides for oscillators (e.g. RSI 30/70). */
  guides?: number[];
  needsBenchmark?: boolean;
  compute(bars: ChartBars, benchmark: number[] | null): Record<string, Series>;
}

const P = PALETTE;

export const INDICATORS: IndicatorDef[] = [
  {
    id: "sma20",
    label: "SMA 20",
    placement: "overlay",
    lines: [{ key: "v", label: "SMA 20", color: P.sky }],
    compute: (b) => ({ v: sma(b.close, 20) }),
  },
  {
    id: "sma50",
    label: "SMA 50",
    placement: "overlay",
    lines: [{ key: "v", label: "SMA 50", color: P.orange }],
    compute: (b) => ({ v: sma(b.close, 50) }),
  },
  {
    id: "sma200",
    label: "SMA 200",
    placement: "overlay",
    lines: [{ key: "v", label: "SMA 200", color: P.purple }],
    compute: (b) => ({ v: sma(b.close, 200) }),
  },
  {
    id: "ema20",
    label: "EMA 20",
    placement: "overlay",
    lines: [{ key: "v", label: "EMA 20", color: P.green }],
    compute: (b) => ({ v: ema(b.close, 20) }),
  },
  {
    id: "ema50",
    label: "EMA 50",
    placement: "overlay",
    lines: [{ key: "v", label: "EMA 50", color: P.vermillion }],
    compute: (b) => ({ v: ema(b.close, 50) }),
  },
  {
    id: "bb20",
    label: "Bollinger (20, 2)",
    placement: "overlay",
    lines: [
      { key: "upper", label: "Upper", color: P.blue, style: "dashed" },
      { key: "middle", label: "Middle", color: P.blue },
      { key: "lower", label: "Lower", color: P.blue, style: "dashed" },
    ],
    compute: (b) => {
      const r = bollinger(b.close, 20, 2);
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: "vwap20",
    label: "VWAP 20 (rolling)",
    placement: "overlay",
    lines: [{ key: "v", label: "VWAP 20", color: P.yellow }],
    compute: (b) => ({ v: vwap(b.high, b.low, b.close, b.volume, 20) }),
  },
  {
    id: "donchian20",
    label: "Donchian (20)",
    placement: "overlay",
    lines: [
      { key: "upper", label: "Upper", color: P.green, style: "dashed" },
      { key: "lower", label: "Lower", color: P.green, style: "dashed" },
    ],
    compute: (b) => {
      const r = donchian(b.high, b.low, 20);
      return { upper: r.upper, lower: r.lower };
    },
  },
  {
    id: "keltner20",
    label: "Keltner (20, 2, 10)",
    placement: "overlay",
    lines: [
      { key: "upper", label: "Upper", color: P.vermillion, style: "dashed" },
      { key: "middle", label: "Middle", color: P.vermillion },
      { key: "lower", label: "Lower", color: P.vermillion, style: "dashed" },
    ],
    compute: (b) => {
      const r = keltner(b.high, b.low, b.close, 20, 2, 10);
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: "rsi14",
    label: "RSI 14",
    placement: "pane",
    lines: [{ key: "v", label: "RSI 14", color: P.purple }],
    guides: [30, 70],
    compute: (b) => ({ v: rsi(b.close, 14) }),
  },
  {
    id: "macd",
    label: "MACD (12, 26, 9)",
    placement: "pane",
    lines: [
      { key: "hist", label: "Histogram", color: P.grey, style: "histogram" },
      { key: "macd", label: "MACD", color: P.blue },
      { key: "signal", label: "Signal", color: P.orange },
    ],
    guides: [0],
    compute: (b) => {
      const r = macd(b.close, 12, 26, 9);
      return { macd: r.macd, signal: r.signal, hist: r.histogram };
    },
  },
  {
    id: "stoch",
    label: "Stochastic (14, 3, 3)",
    placement: "pane",
    lines: [
      { key: "k", label: "%K", color: P.blue },
      { key: "d", label: "%D", color: P.orange },
    ],
    guides: [20, 80],
    compute: (b) => {
      const r = stochastic(b.high, b.low, b.close, 14, 3, 3);
      return { k: r.k, d: r.d };
    },
  },
  {
    id: "adx14",
    label: "ADX / DI 14",
    placement: "pane",
    lines: [
      { key: "adx", label: "ADX", color: P.purple },
      { key: "plus", label: "+DI", color: P.green },
      { key: "minus", label: "−DI", color: P.vermillion },
    ],
    guides: [25],
    compute: (b) => {
      const r = directionalMovement(b.high, b.low, b.close, 14);
      return { adx: r.adx, plus: r.plusDI, minus: r.minusDI };
    },
  },
  {
    id: "atr14",
    label: "ATR 14",
    placement: "pane",
    lines: [{ key: "v", label: "ATR 14", color: P.sky }],
    compute: (b) => ({ v: atr(b.high, b.low, b.close, 14) }),
  },
  {
    id: "cci20",
    label: "CCI 20",
    placement: "pane",
    lines: [{ key: "v", label: "CCI 20", color: P.green }],
    guides: [-100, 100],
    compute: (b) => ({ v: cci(b.high, b.low, b.close, 20) }),
  },
  {
    id: "willr14",
    label: "Williams %R 14",
    placement: "pane",
    lines: [{ key: "v", label: "%R 14", color: P.orange }],
    guides: [-80, -20],
    compute: (b) => ({ v: williamsR(b.high, b.low, b.close, 14) }),
  },
  {
    id: "obv",
    label: "On-balance volume",
    placement: "pane",
    lines: [{ key: "v", label: "OBV", color: P.blue }],
    compute: (b) => ({ v: obv(b.close, b.volume) }),
  },
  {
    id: "vol20",
    label: "Volatility 20 (annualized)",
    placement: "pane",
    lines: [{ key: "v", label: "Volatility 20", color: P.vermillion }],
    compute: (b) => ({
      v: rollingVolatility(b.close, 20).map((x) => (x === null ? null : x * 100)),
    }),
  },
  {
    id: "rs",
    label: "Relative strength vs SPY",
    placement: "pane",
    lines: [{ key: "v", label: "RS vs SPY", color: P.green }],
    guides: [100],
    needsBenchmark: true,
    compute: (b, bench) => ({ v: bench ? relativeStrength(b.close, bench) : [] }),
  },
];

export const INDICATOR_IDS = new Set(INDICATORS.map((i) => i.id));
export const DEFAULT_INDICATORS = ["sma50", "sma200"];

/** More than this many selected indicators are computed off the main thread. */
export const WORKER_THRESHOLD = 5;

export type IndicatorResults = Record<string, Record<string, Series>>;

export function computeIndicators(
  bars: ChartBars,
  benchmark: number[] | null,
  ids: readonly string[],
): IndicatorResults {
  const out: IndicatorResults = {};
  for (const def of INDICATORS) {
    if (!ids.includes(def.id)) continue;
    if (def.needsBenchmark && !benchmark) continue;
    out[def.id] = def.compute(bars, benchmark);
  }
  return out;
}

/** Benchmark closes aligned to the security's dates (carrying the last close over gaps). */
export function alignBenchmark(
  time: readonly string[],
  benchmark: readonly [string, number][] | null,
): number[] | null {
  if (!benchmark?.length) return null;
  const byDate = new Map(benchmark);
  const out: number[] = [];
  let last: number | null = null;
  for (const t of time) {
    const v = byDate.get(t);
    if (v !== undefined) last = v;
    if (last === null) return null; // security starts before the benchmark
    out.push(last);
  }
  return out;
}

export const TIMEFRAMES = ["1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** First date shown for a timeframe ending at `last` (YYYY-MM-DD), or null for all history. */
export function timeframeStart(tf: Timeframe, last: string): string | null {
  const [y, m, d] = last.split("-").map(Number) as [number, number, number];
  const back = (months: number) =>
    new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
  switch (tf) {
    case "1M":
      return back(1);
    case "3M":
      return back(3);
    case "6M":
      return back(6);
    case "YTD":
      return `${y}-01-01`;
    case "1Y":
      return back(12);
    case "5Y":
      return back(60);
    case "MAX":
      return null;
  }
}
