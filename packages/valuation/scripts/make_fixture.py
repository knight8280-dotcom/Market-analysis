#!/usr/bin/env python3
"""
Spreadsheet-style reference for @market/valuation's DCF (Phase 2 step D1).

Computes each scenario row by row, the way a spreadsheet would, independently of the
TypeScript code, and writes:

  test/fixtures/dcf.json   inputs, yearly rows, totals and the sensitivity grid per scenario
  test/fixtures/dcf.csv    scenario "growth"'s yearly rows (open it in any spreadsheet)

Conventions (ADR-027): stage-1 revenue grows at `growth`; EBIT = revenue x margin; FCF =
EBIT x (1 - tax) + D&A - capex - (revenue - previous revenue) x nwcPct; discounting at the end
of each year, / (1 + WACC)^t; terminal value at the end of year N is either year N+1's FCF
(revenue growing at the terminal rate) / (WACC - g) or year N's EBITDA x the exit multiple.

Run: python3 packages/valuation/scripts/make_fixture.py   (standard library only)
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures")

BASE = {
    "revenue0": 1000.0, "years": 5, "growth": 0.08, "ebitMargin": 0.20, "taxRate": 0.21,
    "daPct": 0.04, "capexPct": 0.05, "nwcPct": 0.10, "wacc": 0.09,
    "terminal": {"method": "growth", "growth": 0.025}, "netDebt": 300.0, "shares": 50.0,
}
SCENARIOS = {
    "growth": BASE,
    "multiple": {**BASE, "terminal": {"method": "multiple", "evEbitda": 12.0}},
    "shrinking_net_cash": {
        "revenue0": 2500.0, "years": 10, "growth": -0.02, "ebitMargin": 0.05, "taxRate": 0.25,
        "daPct": 0.03, "capexPct": 0.025, "nwcPct": -0.05, "wacc": 0.07,
        "terminal": {"method": "growth", "growth": 0.0}, "netDebt": -200.0, "shares": None,
    },
}


def year_row(inp, t, prev_revenue, growth):
    revenue = prev_revenue * (1 + growth)
    ebit = revenue * inp["ebitMargin"]
    nopat = ebit * (1 - inp["taxRate"])
    da = revenue * inp["daPct"]
    capex = revenue * inp["capexPct"]
    change_nwc = (revenue - prev_revenue) * inp["nwcPct"]
    fcf = nopat + da - capex - change_nwc
    df = 1 / (1 + inp["wacc"]) ** t
    return {"year": t, "revenue": revenue, "ebit": ebit, "nopat": nopat, "da": da, "capex": capex,
            "changeNwc": change_nwc, "fcf": fcf, "discountFactor": df, "presentValue": fcf * df}


def dcf(inp):
    rows, revenue = [], inp["revenue0"]
    for t in range(1, inp["years"] + 1):
        row = year_row(inp, t, revenue, inp["growth"])
        rows.append(row)
        revenue = row["revenue"]
    last = rows[-1]
    ebitda_n = last["ebit"] + last["da"]
    term = inp["terminal"]
    if term["method"] == "growth":
        nxt = year_row(inp, inp["years"] + 1, last["revenue"], term["growth"])
        tv = nxt["fcf"] / (inp["wacc"] - term["growth"])
    else:
        tv = ebitda_n * term["evEbitda"]
    pv1 = sum(r["presentValue"] for r in rows)
    pv_tv = tv * last["discountFactor"]
    ev = pv1 + pv_tv
    equity = ev - inp["netDebt"]
    return {
        "rows": rows, "pvStage1": pv1, "terminalValue": tv, "pvTerminal": pv_tv,
        "enterpriseValue": ev, "equityValue": equity,
        "perShare": equity / inp["shares"] if inp["shares"] else None,
        "terminalShare": pv_tv / ev,
        "impliedEvEbitda": tv / ebitda_n if ebitda_n > 0 else None,
        "impliedGrowth": (tv * inp["wacc"] - last["fcf"]) / (tv + last["fcf"]),
    }


def grid(inp):
    waccs = [round(inp["wacc"] + d, 10) for d in (-0.02, -0.01, 0, 0.01, 0.02)]
    waccs = [w for w in waccs if w > 0]
    term = inp["terminal"]
    if term["method"] == "growth":
        cols = [round(term["growth"] + d, 10) for d in (-0.01, -0.005, 0, 0.005, 0.01)]
    else:
        cols = [term["evEbitda"] + d for d in (-2, -1, 0, 1, 2) if term["evEbitda"] + d > 0]
    values = []
    for w in waccs:
        row = []
        for c in cols:
            if term["method"] == "growth" and (c >= w or c < -0.05 or c > 0.1):
                row.append(None)
                continue
            t = {"method": "growth", "growth": c} if term["method"] == "growth" else {"method": "multiple", "evEbitda": c}
            r = dcf({**inp, "wacc": w, "terminal": t})
            row.append(r["perShare"] if r["perShare"] is not None else r["equityValue"])
        values.append(row)
    return {"kind": term["method"], "waccs": waccs, "columns": cols, "values": values}


out = {}
for name, inp in SCENARIOS.items():
    out[name] = {"inputs": inp, "result": dcf(inp), "sensitivity": grid(inp)}

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "dcf.json"), "w") as f:
    json.dump(out, f, indent=1)
with open(os.path.join(OUT, "dcf.csv"), "w", newline="") as f:
    w = csv.writer(f)
    keys = ["year", "revenue", "ebit", "nopat", "da", "capex", "changeNwc", "fcf", "discountFactor", "presentValue"]
    w.writerow(keys)
    for r in out["growth"]["result"]["rows"]:
        w.writerow([r[k] if k == "year" else f"{r[k]:.6f}" for k in keys])
for name, o in out.items():
    r = o["result"]
    print(f"{name}: EV={r['enterpriseValue']:.4f} equity={r['equityValue']:.4f} per share={r['perShare']} "
          f"TV share={r['terminalShare']:.4f}")
