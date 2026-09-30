"""Reference fixtures for @market/indicators (Phase 1 step C).

Inputs are a seeded synthetic random walk (no market data). Outputs come from TA-Lib where
TA-Lib has the indicator, and from straightforward NumPy formulas otherwise. Run with TA-Lib
0.8.x, NumPy and pandas installed:

    python3 scripts/make_fixtures.py > test/fixtures/reference.json

The TypeScript tests must match every value within 1e-6 and every null (warm-up) exactly.
"""

import json
import sys

import numpy as np
import pandas as pd
import talib


def walk(n: int, seed: int, start: float) -> dict:
    rng = np.random.default_rng(seed)
    close = start * np.exp(np.cumsum(rng.normal(0.0004, 0.015, n)))
    open_ = np.concatenate([[start], close[:-1]]) * np.exp(rng.normal(0, 0.004, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.008, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.008, n)))
    volume = rng.integers(200_000, 5_000_000, n).astype(float)
    return {"open": open_, "high": high, "low": low, "close": close, "volume": volume}


def out(values) -> list:
    return [None if (v is None or np.isnan(v)) else float(v) for v in np.asarray(values, dtype=float)]


def compute(bars: dict, bench: np.ndarray) -> dict:
    h, l, c, v = bars["high"], bars["low"], bars["close"], bars["volume"]
    macd, signal, hist = talib.MACD(c, 12, 26, 9)
    upper, middle, lower = talib.BBANDS(c, 20, 2.0, 2.0, 0)
    slowk, slowd = talib.STOCH(h, l, c, 14, 3, 0, 3, 0)
    tp = (h + l + c) / 3
    s = pd.Series
    vwap = (s(tp * v).rolling(20).sum() / s(v).rolling(20).sum()).to_numpy()
    donchian_upper = s(h).rolling(20).max().to_numpy()
    donchian_lower = s(l).rolling(20).min().to_numpy()
    ema20, atr10 = talib.EMA(c, 20), talib.ATR(h, l, c, 10)
    logret = np.concatenate([[np.nan], np.diff(np.log(c))])
    vol20 = (s(logret).rolling(20).std(ddof=1) * np.sqrt(252)).to_numpy()
    rs = (c / c[0]) / (bench / bench[0]) * 100
    return {
        "sma20": out(talib.SMA(c, 20)),
        "ema20": out(ema20),
        "wma20": out(talib.WMA(c, 20)),
        "rsi14": out(talib.RSI(c, 14)),
        "macd": out(macd),
        "macdSignal": out(signal),
        "macdHist": out(hist),
        "bbUpper": out(upper),
        "bbMiddle": out(middle),
        "bbLower": out(lower),
        "atr14": out(talib.ATR(h, l, c, 14)),
        "stochK": out(slowk),
        "stochD": out(slowd),
        "obv": out(talib.OBV(c, v)),
        "adx14": out(talib.ADX(h, l, c, 14)),
        "plusDi14": out(talib.PLUS_DI(h, l, c, 14)),
        "minusDi14": out(talib.MINUS_DI(h, l, c, 14)),
        "cci20": out(talib.CCI(h, l, c, 20)),
        "willr14": out(talib.WILLR(h, l, c, 14)),
        "vwap20": out(vwap),
        "donchianUpper": out(donchian_upper),
        "donchianLower": out(donchian_lower),
        "donchianMiddle": out((donchian_upper + donchian_lower) / 2),
        "keltnerMiddle": out(ema20),
        "keltnerUpper": out(ema20 + 2 * atr10),
        "keltnerLower": out(ema20 - 2 * atr10),
        "volatility20": out(vol20),
        "relativeStrength": out(rs),
    }


def case(name: str, bars: dict, bench: np.ndarray) -> dict:
    return {
        "name": name,
        "input": {k: out(bars[k]) for k in ("open", "high", "low", "close", "volume")}
        | {"benchmark": out(bench)},
        "expected": compute(bars, bench),
    }


main = walk(400, 7, 100.0)
bench = walk(400, 11, 400.0)["close"]
flat = {k: np.full(40, 50.0) for k in ("open", "high", "low", "close")} | {"volume": np.full(40, 1e6)}
short = {k: arr[:10] for k, arr in walk(10, 3, 20.0).items()}

json.dump(
    {
        "generator": f"scripts/make_fixtures.py with TA-Lib {talib.__version__}, NumPy {np.__version__}, pandas {pd.__version__}",
        "cases": [
            case("random walk, 400 bars", main, bench),
            case("flat prices, 40 bars", flat, np.full(40, 10.0)),
            case("shorter than every warm-up, 10 bars", short, np.linspace(10, 11, 10)),
        ],
    },
    sys.stdout,
)
