#!/usr/bin/env python3
"""
Independent reference for @market/backtest (Phase 2 steps B4 and B5). Standard library only.

Writes:
  test/fixtures/golden.json   a made-up security (raw bars, a 3:1 split, three cash dividends),
                              and buy-and-hold results computed directly from raw prices and
                              the actions, under the engine's documented conventions:
                                - the always-true entry signal at the first close fills at the
                                  next session's open with all the cash;
                                - a split multiplies the shares on its ex-date;
                                - a cash dividend pays shares x amount on its ex-date and, when
                                  reinvested, buys more shares at that session's open with no
                                  commission;
                                - slippage moves fill prices against the trade; commission is a
                                  fixed amount per fill plus basis points of its value;
                                - equity is cash plus shares x close at every session.
  test/fixtures/metrics.json  an equity series, a risk-free series and trades, with the report
                              metrics computed from their textbook definitions (see
                              src/metrics.ts).

Run: python3 packages/backtest/scripts/make_fixtures.py
"""
import datetime as dt
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures")


def weekdays(start, count):
    d, out = start, []
    while len(out) < count:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


rng = random.Random(20261002)
sessions = weekdays(dt.date(2024, 1, 2), 300)

# Raw bars: a random walk; a 3:1 split divides prices from its ex-date on.
SPLIT_AT, SPLIT_RATIO = 120, 3
DIVIDENDS = [(60, 0.50), (180, 0.20), (250, 0.25)]  # (session index, cash per share that day)
closes, opens, highs, lows = [], [], [], []
price = 90.0
for i in range(len(sessions)):
    o = price * (1 + rng.gauss(0, 0.004))
    c = o * (1 + rng.gauss(0.0004, 0.015))
    if i == SPLIT_AT:
        o /= SPLIT_RATIO
        c /= SPLIT_RATIO
    o, c = round(o, 4), round(c, 4)
    opens.append(o)
    closes.append(c)
    highs.append(round(max(o, c) * (1 + abs(rng.gauss(0, 0.004))), 4))
    lows.append(round(min(o, c) * (1 - abs(rng.gauss(0, 0.004))), 4))
    price = c

security = {
    "ticker": "TEST_GOLD",
    "sessions": sessions,
    "open": opens,
    "high": highs,
    "low": lows,
    "close": closes,
    "splits": [{"exDate": sessions[SPLIT_AT], "ratio": SPLIT_RATIO}],
    "dividends": [{"exDate": sessions[i], "amount": a} for i, a in DIVIDENDS],
}


def buy_and_hold(capital, reinvest, fractional, per_trade, bps, slip_bps):
    slip, rate = slip_bps / 1e4, bps / 1e4
    cash, shares = capital, 0.0
    equity = []
    split_days = {SPLIT_AT: SPLIT_RATIO}
    div_days = dict(DIVIDENDS)
    for i in range(len(sessions)):
        if i in split_days:
            shares *= split_days[i]
        if i in div_days and shares > 0:
            paid = shares * div_days[i]
            cash += paid
            if reinvest:
                px = opens[i] * (1 + slip)
                extra = min(paid, cash) / px
                if not fractional:
                    extra = math.floor(extra + 1e-9)
                shares += extra
                cash -= extra * px
        if i == 1:  # the entry signal from session 0's close fills at this open
            px = opens[i] * (1 + slip)
            n = (cash - per_trade) / (px * (1 + rate))
            if not fractional:
                n = math.floor(n + 1e-9)
            notional = n * px
            cash -= notional + per_trade + notional * rate
            shares += n
        equity.append(cash + shares * closes[i])
    return {"equity": equity, "finalShares": shares, "finalCash": cash}


cases = {
    "reinvest_frictionless": buy_and_hold(100_000, True, True, 0, 0, 0),
    "cash_frictionless": buy_and_hold(100_000, False, True, 0, 0, 0),
    "reinvest_with_costs": buy_and_hold(100_000, True, False, 4.95, 5, 10),
}

# ---- metrics reference ----------------------------------------------------------------------
m_sessions = weekdays(dt.date(2023, 1, 2), 520)
values, v = [], 50_000.0
for i in range(len(m_sessions)):
    v *= 1 + rng.gauss(0.0003, 0.011)
    values.append(v)
rf_dates = m_sessions[::5]
rf_rates = [round(0.045 + 0.005 * math.sin(i / 9), 5) for i in range(len(rf_dates))]
trades = [
    {"pnl": round(rng.gauss(150, 900), 2), "sessionsHeld": rng.randint(1, 60), "open": i % 9 == 0}
    for i in range(40)
]


def latest_rate(date):
    best = None
    for d, r in zip(rf_dates, rf_rates):
        if d <= date:
            best = r
    return best


rets = [values[i] / values[i - 1] - 1 for i in range(1, len(values))]
rf = [latest_rate(m_sessions[i]) / 252 for i in range(1, len(m_sessions))]
excess = [a - b for a, b in zip(rets, rf)]
mean = lambda xs: sum(xs) / len(xs)


def sstd(xs):
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


days = (dt.date.fromisoformat(m_sessions[-1]) - dt.date.fromisoformat(m_sessions[0])).days
cagr = (values[-1] / values[0]) ** (365.25 / days) - 1
downside = math.sqrt(mean([min(x, 0) ** 2 for x in excess]))

# Drawdown: depth, and the longest spell under water measured in sessions.
peak, peak_i, under, mdd, mdd_len = values[0], 0, False, 0.0, 0
for i, x in enumerate(values):
    if x >= peak:
        if under:
            mdd_len = max(mdd_len, i - peak_i)
        under, peak, peak_i = False, x, i
    else:
        under = True
        mdd = max(mdd, 1 - x / peak)
if under:
    mdd_len = max(mdd_len, len(values) - 1 - peak_i)

months, base = [], values[0]
for i, d in enumerate(m_sessions):
    if i == len(m_sessions) - 1 or m_sessions[i + 1][:7] != d[:7]:
        months.append({"month": d[:7], "return": values[i] / base - 1})
        base = values[i]

closed = [t for t in trades if not t["open"]]
wins = [t["pnl"] for t in closed if t["pnl"] > 0]
losses = [t["pnl"] for t in closed if t["pnl"] < 0]
expected = {
    "totalReturn": values[-1] / values[0] - 1,
    "cagr": cagr,
    "volatility": sstd(rets) * math.sqrt(252),
    "sharpe": mean(excess) / sstd(excess) * math.sqrt(252),
    "sortino": mean(excess) / downside * math.sqrt(252),
    "maxDrawdown": mdd,
    "maxDrawdownDuration": mdd_len,
    "calmar": cagr / mdd,
    "bestMonth": max(m["return"] for m in months),
    "worstMonth": min(m["return"] for m in months),
    "monthly": months,
    "trades": len(closed),
    "openTrades": len(trades) - len(closed),
    "winRate": len(wins) / len(closed),
    "profitFactor": sum(wins) / -sum(losses),
    "averageWin": sum(wins) / len(wins),
    "averageLoss": sum(losses) / len(losses),
    "averageSessionsHeld": mean([t["sessionsHeld"] for t in closed]),
}

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "golden.json"), "w") as f:
    json.dump({"security": security, "cases": cases}, f, indent=1)
with open(os.path.join(OUT, "metrics.json"), "w") as f:
    json.dump(
        {
            "sessions": m_sessions,
            "values": values,
            "riskFree": {"dates": rf_dates, "rate": rf_rates},
            "trades": trades,
            "expected": expected,
        },
        f,
        indent=1,
    )
for name, c in cases.items():
    print(f"{name}: final {c['equity'][-1]:.4f} shares {c['finalShares']:.6f} cash {c['finalCash']:.4f}")
print(f"metrics: cagr {cagr:.6f} sharpe {expected['sharpe']:.6f} mdd {mdd:.6f} ({mdd_len} sessions)")
