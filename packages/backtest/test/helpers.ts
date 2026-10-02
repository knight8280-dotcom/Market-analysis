import { tradingDaysBetween } from "@market/calendar";
import { computeAdjustmentFactors, factorFor } from "@market/market-data";
import type { BacktestData, SecurityData } from "../src";
import { resolveStrategy, type StrategyInput } from "../src";

/** Deterministic pseudo-random numbers (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sessions = (start: string, end: string) => tradingDaysBetween(start, end);

export interface SecuritySpec {
  ticker: string;
  dates: string[];
  open: number[];
  close: number[];
  high?: number[];
  low?: number[];
  volume?: number[];
  splits?: { exDate: string; ratio: number }[];
  dividends?: { exDate: string; amount: number }[];
  delistedAt?: string | null;
  membership?: { from: string; to: string | null }[];
}

/**
 * Builds a security as the worker would load it, with adjustment factors from the production
 * adjustment engine (market.adjustment_factors), computed from the bars and actions given.
 */
export function security(spec: SecuritySpec): SecurityData {
  const n = spec.dates.length;
  const high = spec.high ?? spec.close.map((c, i) => Math.max(c, spec.open[i]!) * 1.005);
  const low = spec.low ?? spec.close.map((c, i) => Math.min(c, spec.open[i]!) * 0.995);
  const volume = spec.volume ?? new Array<number>(n).fill(1_000_000);
  const splits = spec.splits ?? [];
  const dividends = spec.dividends ?? [];
  const { factors } = computeAdjustmentFactors(
    [
      ...splits.map((s) => ({
        type: "split" as const,
        ex_date: s.exDate,
        ratio: s.ratio,
        cash_amount: null,
      })),
      ...dividends.map((d) => ({
        type: "cash_dividend" as const,
        ex_date: d.exDate,
        ratio: null,
        cash_amount: d.amount,
      })),
    ],
    (exDate) => {
      const k = spec.dates.findLastIndex((d) => d < exDate);
      return k >= 0 ? spec.close[k]! : null;
    },
  );
  const f = spec.dates.map((d) => factorFor(d, factors));
  return {
    securityId: `id-${spec.ticker}`,
    ticker: spec.ticker,
    bars: {
      dates: spec.dates,
      open: spec.open,
      high,
      low,
      close: spec.close,
      volume,
      splitFactor: f.map((x) => x.split),
      dividendFactor: f.map((x) => x.dividend),
    },
    shareChanges: splits,
    dividends,
    fundamentals: [],
    shares: [],
    membership: spec.membership ?? [{ from: spec.dates[0]!, to: spec.delistedAt ?? null }],
    delistedAt: spec.delistedAt ?? null,
  };
}

/** A random-walk security over `dates`; open = previous close moved a little. */
export function walk(
  ticker: string,
  dates: string[],
  seed: number,
  startPrice = 100,
  drift = 0.0004,
  vol = 0.015,
): SecuritySpec {
  const r = rng(seed);
  const gauss = () => {
    const u = Math.max(r(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const open: number[] = [];
  const close: number[] = [];
  let p = startPrice;
  for (let i = 0; i < dates.length; i++) {
    const o = p * (1 + gauss() * 0.003);
    const c = o * (1 + drift + gauss() * vol);
    open.push(Number(o.toFixed(4)));
    close.push(Number(c.toFixed(4)));
    p = c;
  }
  return { ticker, dates, open, close };
}

export function data(securities: SecurityData[], extra: Partial<BacktestData> = {}): BacktestData {
  const all = [...new Set(securities.flatMap((s) => s.bars.dates))].sort();
  return { sessions: all, securities, benchmark: null, riskFree: null, ...extra };
}

/** A strategy with sensible defaults for tests. */
export function strategy(over: Partial<StrategyInput> & Pick<StrategyInput, "start" | "end">) {
  return resolveStrategy({
    version: 1,
    universe: { kind: "all", assetClass: "any" },
    entry: { combine: "all", rules: [ALWAYS] },
    sizing: { maxPositions: 1 },
    initialCapital: 100_000,
    fractionalShares: true,
    ...over,
  });
}

export const ALWAYS = {
  left: { kind: "const", value: 1 },
  op: ">",
  right: { kind: "const", value: 0 },
} as const;
