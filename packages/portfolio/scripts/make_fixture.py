#!/usr/bin/env python3
"""
Spreadsheet-style reference for @market/portfolio (Phase 1 step J2).

Writes test/fixtures/scenario.json (inputs: made-up securities A and B, benchmark BM, trading
days, raw closes, a 2:1 split, transactions) and the expected results, computed row by row the
way a spreadsheet would, independently of the TypeScript code:

  test/fixtures/expected.json   summary figures and the daily table
  test/fixtures/expected.csv    the daily table, one row per day (open it in any spreadsheet)

Conventions (ADR-023): FIFO lots; a split multiplies the quantity of lots opened before its
ex-date; cash shortfalls at the end of a day are implicit deposits; flows count at the start of
the day, r = V_t / (V_{t-1} + F_t) - 1; XIRR on actual/365 days, found by bisection.

Run: python3 packages/portfolio/scripts/make_fixture.py   (standard library only)
"""
import csv
import datetime as dt
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures")


def business_days(start, end):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d.isoformat()
        d += dt.timedelta(days=1)


days = list(business_days(dt.date(2025, 1, 2), dt.date(2025, 3, 31)))
rng = random.Random(20250102)


def walk(start, vol):
    out, p = [], start
    for _ in days:
        p = round(p * (1 + rng.gauss(0.0005, vol)), 2)
        out.append(p)
    return out


a = walk(100.0, 0.012)
b = walk(40.0, 0.015)
SPLIT_B = "2025-02-03"  # 2:1; raw closes halve from the ex-date on
b = [round(p / 2, 2) if d >= SPLIT_B else p for d, p in zip(days, b)]
bm = walk(500.0, 0.008)  # benchmark, already total-return adjusted

txs = [
    {"date": "2025-01-02", "type": "deposit", "securityId": None, "quantity": None, "price": None, "amount": 10000, "fees": 0},
    {"date": "2025-01-03", "type": "buy", "securityId": "A", "quantity": 50, "price": 100.25, "amount": None, "fees": 1},
    {"date": "2025-01-06", "type": "buy", "securityId": "B", "quantity": 100, "price": 40.10, "amount": None, "fees": 1},
    {"date": "2025-01-15", "type": "buy", "securityId": "A", "quantity": 20, "price": 103.40, "amount": None, "fees": 1},
    {"date": "2025-01-25", "type": "dividend", "securityId": "A", "quantity": None, "price": None, "amount": 12.5, "fees": 0},
    {"date": "2025-02-10", "type": "sell", "securityId": "A", "quantity": 60, "price": 106.00, "amount": None, "fees": 1},
    {"date": "2025-02-14", "type": "withdrawal", "securityId": None, "quantity": None, "price": None, "amount": 2000, "fees": 0},
    {"date": "2025-02-20", "type": "fee", "securityId": None, "quantity": None, "price": None, "amount": 15, "fees": 0},
    {"date": "2025-03-03", "type": "buy", "securityId": "B", "quantity": 300, "price": 21.00, "amount": None, "fees": 1},
    {"date": "2025-03-14", "type": "dividend", "securityId": "B", "quantity": None, "price": None, "amount": 30, "fees": 0},
    {"date": "2025-03-20", "type": "sell", "securityId": "B", "quantity": 150, "price": 22.50, "amount": None, "fees": 1},
]
END = "2025-03-31"
splits = [{"securityId": "B", "exDate": SPLIT_B, "ratio": 2}]
closes = {"A": dict(zip(days, a)), "B": dict(zip(days, b))}

# ---- the "spreadsheet" -------------------------------------------------------------------
rows_dates = sorted(set(days) | {t["date"] for t in txs} | {END})
rows_dates = [d for d in rows_dates if txs[0]["date"] <= d <= END]


def last_close(sec, d):
    known = [x for x in days if x <= d]
    return closes[sec][known[-1]] if known else None


lots = {"A": [], "B": []}  # [open_date, qty, cost_per_share]
cash = 0.0
prev_value = 0.0
index = 1.0
realized = dividends = fees = contributions = 0.0
split_done = set()
table = []
flows = []
for d in rows_dates:
    for s in splits:
        if s["exDate"] <= d and s["exDate"] not in split_done:
            split_done.add(s["exDate"])
            for lot in lots[s["securityId"]]:
                if lot[0] < s["exDate"]:
                    lot[1] *= s["ratio"]
                    lot[2] /= s["ratio"]
    flow = 0.0
    for t in [t for t in txs if t["date"] == d]:
        if t["type"] == "buy":
            cost = t["quantity"] * t["price"] + t["fees"]
            cash -= cost
            fees += t["fees"]
            lots[t["securityId"]].append([d, float(t["quantity"]), cost / t["quantity"]])
        elif t["type"] == "sell":
            q = float(t["quantity"])
            cost_out = 0.0
            book = lots[t["securityId"]]
            while q > 1e-12:
                take = min(book[0][1], q)
                cost_out += take * book[0][2]
                book[0][1] -= take
                q -= take
                if book[0][1] <= 1e-12:
                    book.pop(0)
            proceeds = t["quantity"] * t["price"] - t["fees"]
            cash += proceeds
            fees += t["fees"]
            realized += proceeds - cost_out
        elif t["type"] == "dividend":
            cash += t["amount"]
            dividends += t["amount"]
        elif t["type"] == "deposit":
            cash += t["amount"]
            flow += t["amount"]
        elif t["type"] == "withdrawal":
            cash -= t["amount"]
            flow -= t["amount"]
        elif t["type"] == "fee":
            cash -= t["amount"]
            fees += t["amount"]
    implicit = 0.0
    if cash < 0:
        implicit = -cash
        cash = 0.0
        flow += implicit
    holdings = 0.0
    for sec, book in lots.items():
        qty = sum(l[1] for l in book)
        if qty > 1e-12:
            holdings += qty * last_close(sec, d)
    value = cash + holdings
    base = prev_value + flow
    r = value / base - 1 if base > 0 else 0.0
    index *= 1 + r
    contributions += flow
    if flow != 0:
        flows.append((d, -flow))
    table.append({
        "date": d, "cash": cash, "holdings": holdings, "value": value, "flow": flow,
        "implicitDeposit": implicit, "dailyReturn": r, "index": index,
    })
    prev_value = value

flows.append((END, table[-1]["value"]))


def npv(rate):
    t0 = dt.date.fromisoformat(flows[0][0])
    return sum(amt / (1 + rate) ** ((dt.date.fromisoformat(d) - t0).days / 365) for d, amt in flows)


lo, hi = -0.9999, 10000.0
for _ in range(400):
    mid = (lo + hi) / 2
    if (npv(mid) > 0) == (npv(lo) > 0):
        lo = mid
    else:
        hi = mid
xirr_value = (lo + hi) / 2

peak, mdd = table[0]["index"], 0.0
for row in table:
    peak = max(peak, row["index"])
    mdd = max(mdd, (peak - row["index"]) / peak)

positions = []
for sec, book in lots.items():
    qty = sum(l[1] for l in book)
    if qty <= 1e-12:
        continue
    basis = sum(l[1] * l[2] for l in book)
    price = last_close(sec, END)
    positions.append({"securityId": sec, "quantity": qty, "costBasis": basis, "price": price,
                      "marketValue": qty * price, "unrealized": qty * price - basis})

bm_first = next(i for i, d in enumerate(days) if d >= rows_dates[0])
bm_last = max(i for i, d in enumerate(days) if d <= END)
expected = {
    "twr": table[-1]["index"] - 1,
    "xirr": xirr_value,
    "maxDrawdown": mdd,
    "value": table[-1]["value"],
    "cash": table[-1]["cash"],
    "netContributions": contributions,
    "realized": realized,
    "unrealized": sum(p["unrealized"] for p in positions),
    "dividends": dividends,
    "fees": fees,
    "positions": positions,
    "benchmarkTotal": bm[bm_last] / bm[bm_first] - 1,
    "days": table,
}
scenario = {
    "end": END,
    "calendar": days,
    "prices": {"A": {"dates": days, "closes": a}, "B": {"dates": days, "closes": b}},
    "benchmark": {"dates": days, "closes": bm},
    "splits": splits,
    "transactions": txs,
}

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "scenario.json"), "w") as f:
    json.dump(scenario, f, indent=1)
with open(os.path.join(OUT, "expected.json"), "w") as f:
    json.dump(expected, f, indent=1)
with open(os.path.join(OUT, "expected.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "cash", "holdings", "value", "flow", "implicit_deposit", "daily_return", "twr_index"])
    for row in table:
        w.writerow([row["date"], f"{row['cash']:.6f}", f"{row['holdings']:.6f}", f"{row['value']:.6f}",
                    f"{row['flow']:.6f}", f"{row['implicitDeposit']:.6f}", f"{row['dailyReturn']:.10f}",
                    f"{row['index']:.10f}"])
print(f"days={len(table)} twr={expected['twr']:.6%} xirr={xirr_value:.6%} mdd={mdd:.6%} "
      f"value={expected['value']:.2f} realized={realized:.2f}")
