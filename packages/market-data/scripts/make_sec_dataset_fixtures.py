#!/usr/bin/env python3
"""
Trimmed recordings of SEC bulk data sets, plus expected results computed independently of the
TypeScript code (Phase 2 step H2).

Inputs (downloaded from sec.gov; public domain):
  01mar2026-31may2026_form13f.zip, 01jun2026-31aug2026_form13f.zip  (Form 13F data sets)
  cnsfails202608b.zip, cnsfails202609a.zip                         (fails-to-deliver data)

Writes, under test/fixtures/sec-edgar/recorded/:
  form13f/<same names>.zip   every row of the chosen filings, all seven tables, same layout
  ftd/<same names>.zip       the header, the chosen rows and a trailer recounted for them
  form13f/expected.json      filings, per-filing holdings and effective positions

Effective position for a filer, period and security: the latest 13F-HR or restating 13F-HR/A
(by filing date, then accession), plus every NEW HOLDINGS amendment filed after it; shares
(SH, not puts or calls) and value summed over their rows. Value is dollars for filings on or
after 2023-01-03 and thousands before (SEC data set notes).

Run: python3 packages/market-data/scripts/make_sec_dataset_fixtures.py <folder with the zips>
"""
import csv
import io
import json
import os
import sys
import zipfile
from collections import defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "test", "fixtures", "sec-edgar", "recorded")
OURS = {
    "037833100": "AAPL",
    "02079K305": "GOOGL",
    "02079K107": "GOOG",
    "084670702": "BRK-B",
    "78462F103": "SPY",
    "30303M102": "META",
}
SETS = {
    "01mar2026-31may2026_form13f.zip": [
        "0002051108-26-000004",  # small filer, Q1: AAPL, GOOGL
        "0001907433-26-000002",  # Q1: AAPL, BRK-B, SPY
        "0001062993-26-002581",  # filer 0000733986, Q1 original (restated in the next set)
        "0002046333-26-000002",  # Q1: AAPL, GOOG, GOOGL, META (sells AAPL and GOOGL by Q2)
        "0000949853-26-000002",  # Q1 original, none of ours (restated in the next set)
    ],
    "01jun2026-31aug2026_form13f.zip": [
        "0002051108-26-000005",  # Q2: opens GOOG
        "0001907433-26-000003",  # Q2
        "0001062993-26-003311",  # filer 0000733986, Q1 RESTATEMENT filed in June
        "0001062993-26-004369",  # filer 0000733986, Q2
        "0002046333-26-000003",  # Q2: GOOG, META only
        "0000949853-26-000005",  # Q2 original
        "0000949853-26-000008",  # Q2 RESTATEMENT, same day
        "0000949853-26-000009",  # Q2 NEW HOLDINGS, same day
        "0000949853-26-000003",  # Q1 RESTATEMENT (19 rows)
        "0000949853-26-000004",  # Q1 NEW HOLDINGS (45 rows, adds AAPL, GOOG, META)
        "0001172661-26-002768",  # filer 0001904821: SPY on two rows
        "0002040405-26-000011",  # puts or calls on our securities (left out)
        "0000921895-26-001911",  # 13F-NT: notice, no holdings
        "0002134841-26-000139",  # a 2026 filing for the period ended 2001-09-30
        "0001818386-26-000003",  # AAPL on two share rows (summed)
        "0001911876-26-000019",  # NEW HOLDINGS for Q1 whose original is not in either set
    ],
}
FTD = ["cnsfails202608b.zip", "cnsfails202609a.zip"]
FTD_KEEP = set(OURS) | {"G8021C104"}  # plus a row whose price is "."
FROM_PERIOD = "2024-01-01"


def iso(dmy):
    return datetime.strptime(dmy, "%d-%b-%Y").strftime("%Y-%m-%d")


def tables(path):
    z = zipfile.ZipFile(path)
    out = {}
    for info in z.infolist():
        if not info.filename.endswith(".tsv"):
            continue
        with z.open(info) as f:
            text = io.TextIOWrapper(f, encoding="utf-8", newline="")
            reader = csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE)
            header = next(reader)
            out[info.filename] = (header, list(reader))
    return out


def write_zip(path, files):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(zipfile.ZipInfo(name, date_time=(2026, 10, 2, 0, 0, 0)), data, zipfile.ZIP_DEFLATED)


def main(src):
    os.makedirs(os.path.join(OUT, "form13f"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "ftd"), exist_ok=True)
    expected = {"sets": {}, "positions": []}
    filings = {}
    per_filing = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))

    for name, keep in SETS.items():
        t = tables(os.path.join(src, name))
        keep = set(keep)
        files = []
        for table in sorted(t):
            header, rows = t[table]
            ai = header.index("ACCESSION_NUMBER")
            chosen = [r for r in rows if r[ai] in keep]
            body = "\t".join(header) + "\n" + "".join("\t".join(r) + "\n" for r in chosen)
            files.append((table, body.encode("utf-8")))
        write_zip(os.path.join(OUT, "form13f", name), files)

        sub = {r[0]: dict(zip(t["SUBMISSION.tsv"][0], r)) for r in t["SUBMISSION.tsv"][1] if r[0] in keep}
        cov = {r[0]: dict(zip(t["COVERPAGE.tsv"][0], r)) for r in t["COVERPAGE.tsv"][1] if r[0] in keep}
        summ = {r[0]: dict(zip(t["SUMMARYPAGE.tsv"][0], r)) for r in t["SUMMARYPAGE.tsv"][1] if r[0] in keep}
        set_filings = []
        for acc, s in sorted(sub.items()):
            period = iso(s["PERIODOFREPORT"])
            if period < FROM_PERIOD:
                continue
            c, sm = cov[acc], summ.get(acc, {})
            f = {
                "accession_no": acc,
                "filer_cik": s["CIK"].strip().zfill(10),
                "filer_name": c["FILINGMANAGER_NAME"].strip(),
                "submission_type": s["SUBMISSIONTYPE"],
                "report_type": c["REPORTTYPE"].strip(),
                "report_period": period,
                "filed_on": iso(s["FILING_DATE"]),
                "amendment_type": c["AMENDMENTTYPE"] or None,
                "table_entry_total": int(sm["TABLEENTRYTOTAL"]) if sm.get("TABLEENTRYTOTAL") else None,
                "table_value_total": int(sm["TABLEVALUETOTAL"]) if sm.get("TABLEVALUETOTAL") else None,
            }
            filings[acc] = f
            set_filings.append(f)
        header, rows = t["INFOTABLE.tsv"]
        col = {h: i for i, h in enumerate(header)}
        for r in rows:
            acc = r[col["ACCESSION_NUMBER"]]
            cusip = r[col["CUSIP"]].strip().upper()  # some filers write CUSIPs in lower case
            if acc not in filings or cusip not in OURS:
                continue
            if r[col["SSHPRNAMTTYPE"]] != "SH" or r[col["PUTCALL"]]:
                continue
            value = int(r[col["VALUE"]])
            if filings[acc]["filed_on"] < "2023-01-03":
                value *= 1000
            agg = per_filing[acc][cusip]
            agg[0] += int(r[col["SSHPRNAMT"]])
            agg[1] += value
            agg[2] += 1
        counts = defaultdict(int)
        for r in rows:
            counts[r[col["ACCESSION_NUMBER"]]] += 1
        mismatches = sorted(
            f["accession_no"]
            for f in set_filings
            if f["table_entry_total"] is not None
            and f["submission_type"].startswith("13F-HR")
            and counts[f["accession_no"]] != f["table_entry_total"]
        )
        expected["sets"][name] = {
            "row_count_mismatches": mismatches,
            "filings": set_filings,
            "holdings": [
                {"accession_no": acc, "cusip": cusip, "shares": v[0], "value_usd": v[1], "rows": v[2]}
                for acc in sorted(per_filing)
                if acc in sub
                for cusip, v in sorted(per_filing[acc].items())
            ],
        }

    groups = defaultdict(list)
    for f in filings.values():
        if f["submission_type"] in ("13F-HR", "13F-HR/A"):
            groups[(f["filer_cik"], f["report_period"])].append(f)
    for (filer, period), fs in sorted(groups.items()):
        key = lambda f: (f["filed_on"], f["accession_no"])
        bases = [f for f in fs if f["amendment_type"] != "NEW HOLDINGS"]
        if not bases:
            continue
        base = max(bases, key=key)
        included = [base] + [
            f for f in fs if f["amendment_type"] == "NEW HOLDINGS" and key(f) > key(base)
        ]
        included.sort(key=key)
        totals = defaultdict(lambda: [0, 0])
        for f in included:
            for cusip, v in per_filing[f["accession_no"]].items():
                totals[cusip][0] += v[0]
                totals[cusip][1] += v[1]
        for cusip, (shares, value) in sorted(totals.items()):
            contributing = [f for f in included if cusip in per_filing[f["accession_no"]]]
            expected["positions"].append({
                "filer_cik": filer,
                "report_period": period,
                "ticker": OURS[cusip],
                "cusip": cusip,
                "shares": shares,
                "value_usd": value,
                "filer_name": base["filer_name"],
                "filed_on": max(f["filed_on"] for f in contributing),
                "accession_nos": [f["accession_no"] for f in contributing],
            })

    latest = {}
    for name in FTD:
        z = zipfile.ZipFile(os.path.join(src, name))
        inner = z.infolist()[0].filename
        lines = z.read(inner).decode("latin-1").splitlines()
        header, data = lines[0], [l for l in lines[1:] if l.split("|")[1:2] and l.split("|")[1] in FTD_KEEP]
        body = header + "\n" + "".join(l + "\n" for l in data)
        quantity = sum(int(l.split("|")[3]) for l in data)
        body += f"Trailer record count {len(data)}\nTrailer total quantity of shares {quantity}\n"
        write_zip(os.path.join(OUT, "ftd", name), [(inner, body.encode("latin-1"))])
        for l in data:
            d, cusip, symbol, _q, desc, _p = l.split("|")
            date = f"{d[:4]}-{d[4:6]}-{d[6:]}"
            prev = latest.get(cusip)
            first = min(prev["first_seen"], date) if prev else date
            if not prev or date >= prev["last_seen"]:
                latest[cusip] = {"symbol": symbol, "description": desc.strip(), "last_seen": date, "first_seen": first}
            else:
                prev["first_seen"] = first
    expected["ftd"] = {c: v for c, v in sorted(latest.items())}

    with open(os.path.join(OUT, "form13f", "expected.json"), "w") as f:
        json.dump(expected, f, indent=1, sort_keys=True)
        f.write("\n")
    print(len(filings), "filings;", len(expected["positions"]), "positions;", len(latest), "CUSIPs from FTD")


if __name__ == "__main__":
    main(sys.argv[1])
