import * as ind from "@market/indicators";
import type { Series } from "@market/indicators";
import type { SecurityData } from "./data";
import { fundamentalsOn } from "./pit";
import { INDICATORS, type IndicatorSpec, type Operand, type OperandUnit } from "./schema";

/**
 * Operand values for one security (Phase 2 step B2).
 *
 * Indicators are computed once over the security's adjusted history (adjusted for every split
 * and dividend in the data). Read naively, that history leaks the future: a stock that splits
 * 4:1 next year shows a quarter of today's price today. So every value read on session t is put
 * back into the terms of session t: price-based values are divided by bar t's adjustment factor
 * and volume-based ones multiplied by its split factor. Indicators here are scale-consistent
 * (homogeneous in price or in volume), so this equals computing them on the history as it was
 * adjusted on session t. Ratios (RSI, %R, ADX, volatility...) need no rescaling.
 */
export class SecurityView {
  readonly index = new Map<string, number>();
  private readonly adj: {
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
  };
  private readonly factor: number[];
  private readonly cache = new Map<string, Series>();

  constructor(readonly data: SecurityData) {
    const b = data.bars;
    b.dates.forEach((d, i) => this.index.set(d, i));
    this.factor = b.splitFactor.map((s, i) => s * b.dividendFactor[i]!);
    const scale = (xs: number[]) => xs.map((x, i) => x * this.factor[i]!);
    this.adj = {
      open: scale(b.open),
      high: scale(b.high),
      low: scale(b.low),
      close: scale(b.close),
      volume: b.volume.map((v, i) => v / b.splitFactor[i]!),
    };
  }

  /** Bar index on `date`, or -1 when the security did not trade that session. */
  bar(date: string): number {
    return this.index.get(date) ?? -1;
  }

  private series(o: Extract<Operand, { kind: "indicator" }>): Series {
    const spec: IndicatorSpec = INDICATORS[o.id];
    const p = (k: string) => o.params[k] ?? spec.params[k]!.default;
    const key = `${o.id}|${Object.keys(spec.params)
      .map((k) => p(k))
      .join(",")}|${o.output}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const { open: _open, high, low, close, volume } = this.adj;
    let out: Series;
    switch (o.id) {
      case "sma":
        out = ind.sma(close, p("period"));
        break;
      case "ema":
        out = ind.ema(close, p("period"));
        break;
      case "wma":
        out = ind.wma(close, p("period"));
        break;
      case "rsi":
        out = ind.rsi(close, p("period"));
        break;
      case "macd":
        out = ind.macd(close, p("fast"), p("slow"), p("signal"))[
          o.output as "macd" | "signal" | "histogram"
        ];
        break;
      case "bollinger":
        out = ind.bollinger(close, p("period"), p("k"))[o.output as "upper" | "middle" | "lower"];
        break;
      case "atr":
        out = ind.atr(high, low, close, p("period"));
        break;
      case "stochastic":
        out = ind.stochastic(high, low, close, p("kPeriod"), p("kSmoothing"), p("dPeriod"))[
          o.output as "k" | "d"
        ];
        break;
      case "williams_r":
        out = ind.williamsR(high, low, close, p("period"));
        break;
      case "cci":
        out = ind.cci(high, low, close, p("period"));
        break;
      case "adx": {
        const dm = ind.directionalMovement(high, low, close, p("period"));
        out = o.output === "plus_di" ? dm.plusDI : o.output === "minus_di" ? dm.minusDI : dm.adx;
        break;
      }
      case "obv":
        out = ind.obv(close, volume);
        break;
      case "volatility":
        out = ind.rollingVolatility(close, p("period"));
        break;
      case "donchian":
        out = ind.donchian(high, low, p("period"))[o.output as "upper" | "middle" | "lower"];
        break;
      case "keltner":
        out = ind.keltner(high, low, close, p("period"), p("multiplier"), p("atrPeriod"))[
          o.output as "upper" | "middle" | "lower"
        ];
        break;
      case "vwap":
        out = ind.vwap(high, low, close, volume, p("period"));
        break;
    }
    this.cache.set(key, out);
    return out;
  }

  /** Rescale a value read on bar `j` into the terms of bar `j` (see the class comment). */
  private asOf(value: number | null, unit: OperandUnit, j: number): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    if (unit === "price") return value / this.factor[j]!;
    if (unit === "volume") return value * this.data.bars.splitFactor[j]!;
    return value;
  }

  /**
   * The operand's value as known at the close of bar `j`, looking `extraAgo` further back (for
   * crossings). Never reads a bar after `j`.
   */
  value(o: Operand, j: number, extraAgo = 0): number | null {
    switch (o.kind) {
      case "const":
        return o.value;
      case "price": {
        const k = j - o.barsAgo - extraAgo;
        return k < 0 ? null : this.asOf(this.adj[o.field][k]!, "price", j);
      }
      case "volume": {
        const k = j - o.barsAgo - extraAgo;
        return k < 0 ? null : this.asOf(this.adj.volume[k]!, "volume", j);
      }
      case "indicator": {
        const k = j - o.barsAgo - extraAgo;
        if (k < 0) return null;
        return this.asOf(this.series(o)[k] ?? null, INDICATORS[o.id].unit, j);
      }
      case "fundamental": {
        const k = j - extraAgo;
        if (k < 0) return null;
        const b = this.data.bars;
        const f = fundamentalsOn(this.data, b.dates[k]!, b.close[k]!);
        switch (o.metric) {
          case "pe_ttm":
            return f.peTtm;
          case "ps_ttm":
            return f.psTtm;
          case "market_cap":
            return f.marketCap;
          case "revenue_growth_yoy":
            return f.revenueGrowthYoy;
          case "net_margin_ttm":
            return f.netMarginTtm;
        }
      }
    }
  }
}
