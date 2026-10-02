import { describe, expect, it } from "vitest";
import {
  AlertDefinition,
  describeAlert,
  evaluateAlert,
  type EvaluationInput,
  type InsiderPurchaseFiling,
} from "../src";

/** Phase 2 step H4: open-market purchases reported on Form 4. */
const NOW = new Date("2026-09-30T21:00:00Z");
const def = (minValue: number) =>
  AlertDefinition.parse({ kind: "insider_purchase", params: { minValue } });
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  ticker: "TESTX",
  bar: null,
  earnings: null,
  today: "2026-09-30",
  now: NOW,
  lastFiredAt: null,
  cooldownHours: 0,
  ...over,
});
const filing = (
  n: number,
  lines: InsiderPurchaseFiling["lines"],
  stored = "2026-09-30T20:00:00Z",
): InsiderPurchaseFiling => ({
  accessionNo: `0000000042-26-00000${n}`,
  filedAt: new Date(`2026-09-2${n}T20:30:00Z`),
  filingDate: `2026-09-2${n}`,
  url: `https://www.sec.gov/Archives/edgar/data/42/${n}/form4.xml`,
  storedAt: new Date(stored),
  insider: n === 2 ? "Fund LP and 1 other" : "Doe Jane",
  role: n === 2 ? "10% owner" : "Director, CEO",
  lines,
});

describe("insider purchases", () => {
  it("fires for new purchases, keyed by the latest filing, describing what was filed", () => {
    const r = evaluateAlert(
      def(0),
      input({
        insiderPurchases: [
          filing(1, [{ date: "2026-09-18", shares: 1000, price: 25.5 }]),
          filing(2, [
            { date: "2026-09-19", shares: 300, price: 10 },
            { date: "2026-09-20", shares: 200, price: 12 },
            { date: "2026-09-20", shares: 50, price: null },
          ]),
        ],
      }),
    );
    expect(r).toMatchObject({
      fire: true,
      key: "0000000042-26-000002",
      date: "2026-09-22",
      subject: "2 insider purchases at TESTX",
      href: "https://www.sec.gov/Archives/edgar/data/42/2/form4.xml",
      state: { insidersSeenThrough: "2026-09-30T20:00:00.000Z" },
    });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.summary!.split("\n")).toEqual([
      "Open-market purchases of TESTX reported on Form 4:",
      "- Doe Jane (Director, CEO) bought 1,000 shares at $25.50 on Sep 18, 2026, $25,500.00 at the filed prices; Form 4 accepted Sep 21, 2026, 4:30 PM ET",
      "- Fund LP and 1 other (10% owner) bought 550 shares at $10.00 to $12.00 on Sep 19, 2026 to Sep 20, 2026, $5,400.00 at the filed prices; Form 4 accepted Sep 22, 2026, 4:30 PM ET",
    ]);
    expect(r.text).toContain("https://www.sec.gov/Archives/edgar/data/42/1/form4.xml");
    expect(r.text + r.subject).not.toMatch(/should|recommend|buy now/i);
  });

  it("keeps to the minimum value and remembers filings it has read", () => {
    const small = filing(1, [{ date: "2026-09-18", shares: 10, price: 25 }]);
    expect(evaluateAlert(def(1000), input({ insiderPurchases: [small] }))).toEqual({
      fire: false,
      reason: "not_met",
      state: { insidersSeenThrough: "2026-09-30T20:00:00.000Z" },
    });
    // Already read: nothing new.
    const state = { insidersSeenThrough: "2026-09-30T20:00:00.000Z" };
    expect(evaluateAlert(def(0), input({ insiderPurchases: [small], state }))).toEqual({
      fire: false,
      reason: "not_met",
    });
    // A purchase without a price counts only when no minimum is set.
    const unpriced = filing(
      3,
      [{ date: "2026-09-23", shares: 500, price: null }],
      "2026-09-30T20:00:01Z",
    );
    expect(evaluateAlert(def(1), input({ insiderPurchases: [unpriced], state }))).toMatchObject({
      fire: false,
    });
    expect(evaluateAlert(def(0), input({ insiderPurchases: [unpriced], state }))).toMatchObject({
      fire: true,
      subject: "Insider purchase at TESTX: Doe Jane",
    });
  });

  it("has no data without an SEC registrant id, and waits out a snooze", () => {
    expect(evaluateAlert(def(0), input({ insiderPurchases: null }))).toEqual({
      fire: false,
      reason: "no_data",
    });
    const f = filing(1, [{ date: "2026-09-18", shares: 1000, price: 25 }]);
    expect(
      evaluateAlert(
        def(0),
        input({ insiderPurchases: [f], snoozedUntil: new Date("2026-10-05T00:00:00Z") }),
      ),
    ).toEqual({ fire: false, reason: "snoozed" });
  });

  it("describes the condition and refuses a negative minimum", () => {
    expect(describeAlert(def(0))).toBe("An insider buys on the open market (Form 4)");
    expect(describeAlert(def(250000))).toBe(
      "An insider buys at least $250,000 on the open market (Form 4)",
    );
    expect(
      AlertDefinition.safeParse({ kind: "insider_purchase", params: { minValue: -1 } }).success,
    ).toBe(false);
    expect(AlertDefinition.safeParse({ kind: "insider_purchase", params: {} }).success).toBe(false);
  });
});
