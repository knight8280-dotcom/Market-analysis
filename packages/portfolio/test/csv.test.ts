import { describe, expect, it } from "vitest";
import { CSV_TEMPLATE, parseCsv, parseTransactionsCsv } from "../src";

const today = "2026-09-30";

describe("parseCsv", () => {
  it("reads quoted fields with commas, quotes and line breaks, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n2,"two\nlines"\n\n');
    expect(rows).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["1", 'x, "y"'] },
      { line: 3, fields: ["2", "two\nlines"] },
    ]);
  });
});

describe("parseTransactionsCsv", () => {
  it("accepts the template", () => {
    const { rows, errors } = parseTransactionsCsv(CSV_TEMPLATE, { today });
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.line, r.type, r.ticker])).toEqual([
      [2, "deposit", null],
      [3, "buy", "SPY"],
      [4, "dividend", "SPY"],
      [5, "sell", "SPY"],
    ]);
    expect(rows[1]).toMatchObject({ quantity: 10, price: 472.65, amount: 4726.5, fees: 1 });
  });

  it("takes columns in any order and case, amounts with $ and thousands separators", () => {
    const { rows, errors } = parseTransactionsCsv(
      'Type,Date,Amount,Notes\ndeposit,2025-01-02,"$1,250.50","first, deposit"\n',
      { today },
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ type: "deposit", amount: 1250.5, notes: "first, deposit" });
  });

  it("reports every problem by line and keeps the good rows", () => {
    const { rows, errors } = parseTransactionsCsv(
      [
        "date,type,ticker,quantity,price,amount,fees",
        "2025-13-01,buy,AAPL,1,10,,",
        "2025-01-02,transfer,,,,5,",
        "2025-01-02,buy,,0,,,",
        "2025-01-02,deposit,,,,-5,",
        "2025-01-02,sell,AAPL,2,10,25,",
        "2099-01-01,deposit,,,,5,",
        "2025-01-02,fee,AAPL,,,5,",
        "2025-01-03,buy,aapl,1.5,190.1,,0.5",
      ].join("\n"),
      { today },
    );
    expect(errors).toEqual([
      { line: 2, message: 'date "2025-13-01" is not a YYYY-MM-DD date.' },
      {
        line: 3,
        message: 'type "transfer" is not one of buy, sell, dividend, deposit, withdrawal, fee.',
      },
      {
        line: 4,
        message: "a buy needs a ticker; a buy needs a quantity above 0; a buy needs a price.",
      },
      {
        line: 5,
        message: "amount must be a number of 0 or more; a deposit needs an amount above 0.",
      },
      {
        line: 6,
        message: "amount 25 is not quantity × price (20); leave it empty.",
      },
      { line: 7, message: "date 2099-01-01 is in the future." },
      { line: 8, message: "a fee has no ticker." },
    ]);
    expect(rows).toEqual([
      {
        line: 9,
        date: "2025-01-03",
        type: "buy",
        ticker: "AAPL",
        quantity: 1.5,
        price: 190.1,
        amount: 285.15,
        fees: 0.5,
        notes: null,
      },
    ]);
  });

  it("rejects a wrong header or an empty file", () => {
    expect(parseTransactionsCsv("when,what\n", { today }).errors[0]!.message).toBe(
      "Missing columns: date, type. Unknown columns: when, what. Expected: date,type,ticker,quantity,price,amount,fees,notes.",
    );
    expect(parseTransactionsCsv("", { today }).errors[0]!.message).toBe("The file is empty.");
    expect(parseTransactionsCsv("date,type\n", { today }).errors[0]!.message).toBe(
      "No transactions below the header.",
    );
  });
});
