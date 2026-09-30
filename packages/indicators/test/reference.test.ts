import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  wma,
  type Series,
} from "../src";

/**
 * Every indicator against reference output (test/fixtures/reference.json, produced by
 * scripts/make_fixtures.py from TA-Lib where it has the indicator, NumPy formulas otherwise).
 * Values must agree within 1e-6 (absolute; the worst seen is about 4e-12) and warm-up nulls
 * must line up exactly.
 */
interface Case {
  name: string;
  input: Record<"open" | "high" | "low" | "close" | "volume" | "benchmark", number[]>;
  expected: Record<string, (number | null)[]>;
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/reference.json", import.meta.url)), "utf8"),
) as { cases: Case[] };

const TOLERANCE = 1e-6;

function compare(actual: Series, expected: (number | null)[]): string | null {
  if (actual.length !== expected.length) return `length ${actual.length} ≠ ${expected.length}`;
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i] ?? null;
    const e = expected[i] ?? null;
    if (a === null || e === null) {
      if (a !== e) return `index ${i}: ${String(a)} ≠ ${String(e)}`;
    } else if (Math.abs(a - e) > TOLERANCE) {
      return `index ${i}: ${a} ≠ ${e}`;
    }
  }
  return null;
}

function compute(input: Case["input"]): Record<string, Series> {
  const { high, low, close, volume, benchmark } = input;
  const m = macd(close, 12, 26, 9);
  const bb = bollinger(close, 20, 2);
  const st = stochastic(high, low, close, 14, 3, 3);
  const dm = directionalMovement(high, low, close, 14);
  const dc = donchian(high, low, 20);
  const kc = keltner(high, low, close, 20, 2, 10);
  return {
    sma20: sma(close, 20),
    ema20: ema(close, 20),
    wma20: wma(close, 20),
    rsi14: rsi(close, 14),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.histogram,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    atr14: atr(high, low, close, 14),
    stochK: st.k,
    stochD: st.d,
    obv: obv(close, volume),
    adx14: dm.adx,
    plusDi14: dm.plusDI,
    minusDi14: dm.minusDI,
    cci20: cci(high, low, close, 20),
    willr14: williamsR(high, low, close, 14),
    vwap20: vwap(high, low, close, volume, 20),
    donchianUpper: dc.upper,
    donchianLower: dc.lower,
    donchianMiddle: dc.middle,
    keltnerMiddle: kc.middle,
    keltnerUpper: kc.upper,
    keltnerLower: kc.lower,
    volatility20: rollingVolatility(close, 20),
    relativeStrength: relativeStrength(close, benchmark),
  };
}

describe.each(fixture.cases)("reference: $name", (c) => {
  const actual = compute(c.input);
  it.each(Object.keys(c.expected))("%s", (key) => {
    expect(actual[key], `no implementation for ${key}`).toBeDefined();
    expect(compare(actual[key]!, c.expected[key]!)).toBeNull();
  });
});

describe("input checks", () => {
  it("rejects bad periods and mismatched arrays", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => sma([1, 2, 3], 1.5)).toThrow(RangeError);
    expect(() => atr([1, 2], [1], [1, 2], 14)).toThrow(RangeError);
    expect(() => rollingVolatility([1, 2, 3], 1)).toThrow(RangeError);
  });

  it("returns empty output for empty input", () => {
    expect(sma([], 5)).toEqual([]);
    expect(obv([], [])).toEqual([]);
    expect(relativeStrength([], [])).toEqual([]);
    expect(macd([]).macd).toEqual([]);
  });
});
