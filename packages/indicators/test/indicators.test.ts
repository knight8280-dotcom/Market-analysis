import { describe, expect, it } from "vitest";
import { atr, ema, macd, obv, relativeStrength, rsi, sma, wma } from "../src";

describe("hand-checked values", () => {
  it("SMA, WMA and EMA warm up with nulls", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    // (1·1 + 2·2 + 3·3) / 6
    expect(wma([1, 2, 3], 3)).toEqual([null, null, 14 / 6]);
    // Seed = SMA(1, 2, 3) = 2; then 2 + (4 - 2) · 0.5 = 3.
    expect(ema([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  it("RSI is 100 when prices only rise and 0 when they only fall", () => {
    const up = Array.from({ length: 20 }, (_, i) => 10 + i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi([...up].reverse(), 14).at(-1)).toBe(0);
    expect(
      rsi(up, 14)
        .slice(0, 14)
        .every((v) => v === null),
    ).toBe(true);
  });

  it("ATR of a constant 1-point range is 1", () => {
    const close = Array.from({ length: 30 }, () => 10);
    const high = close.map((c) => c + 0.5);
    const low = close.map((c) => c - 0.5);
    expect(atr(high, low, close, 14).at(-1)).toBeCloseTo(1, 12);
  });

  it("MACD starts once the signal line has warmed up", () => {
    const close = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
    const m = macd(close);
    expect(m.macd.findIndex((v) => v !== null)).toBe(33);
    expect(m.histogram[40]).toBeCloseTo(m.macd[40]! - m.signal[40]!, 12);
  });

  it("OBV accumulates volume by the close's direction", () => {
    expect(obv([10, 11, 11, 10], [5, 7, 9, 2])).toEqual([5, 12, 12, 10]);
  });

  it("relative strength is flat at 100 against itself", () => {
    const s = [10, 12, 9, 15];
    expect(relativeStrength(s, s)).toEqual([100, 100, 100, 100]);
  });
});

describe("performance", () => {
  it("computes all overlays for 2,500 bars quickly", () => {
    const close = Array.from({ length: 2500 }, (_, i) => 100 * Math.exp(Math.sin(i / 50) / 5));
    const started = performance.now();
    sma(close, 200);
    ema(close, 50);
    rsi(close, 14);
    macd(close);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
