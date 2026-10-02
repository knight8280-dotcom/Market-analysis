import { rsi } from "@market/indicators";
import { describe, expect, it } from "vitest";
import {
  AlertDefinition,
  describeAlert,
  evaluateAlert,
  fingerprint,
  formName,
  parseState,
  type DailySeries,
  type EvaluationInput,
  type FilingItem,
  type ScreenResults,
} from "../src";

/** Phase 2 step E1: indicator, volume, filing and screen conditions, plus snoozing. */

const NOW = new Date("2026-09-30T21:00:00Z");
const def = (kind: string, params: unknown) => AlertDefinition.parse({ kind, params });

function dates(n: number, end = "2026-09-30"): string[] {
  // Consecutive calendar days ending at `end`; the evaluator only uses their order.
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(last - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}
const series = (close: number[], volume?: number[]): DailySeries => ({
  dates: dates(close.length),
  close,
  volume: volume ?? close.map(() => 1_000),
});
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  ticker: "TESTX",
  bar: null,
  earnings: null,
  today: "2026-09-30",
  now: NOW,
  lastFiredAt: null,
  cooldownHours: 24,
  ...over,
});

describe("RSI crossings", () => {
  // A steady rise, then three falls; RSI(14) drops from the 60s towards 30 and below.
  const closes = [
    ...Array.from({ length: 30 }, (_, i) => 100 + i * 0.5 + (i % 3 === 0 ? -0.8 : 0)),
    112,
    109,
    105,
    100,
  ];
  const values = rsi(closes, 14);
  const curr = values.at(-1)!;
  const prev = values.at(-2)!;

  it("fires when RSI closes below the level after being at or above it", () => {
    const level = (prev + curr) / 2;
    const r = evaluateAlert(
      def("rsi_below", { level, period: 14 }),
      input({ series: series(closes) }),
    );
    expect(r).toMatchObject({ fire: true, key: "2026-09-30", date: "2026-09-30" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.subject).toBe(`TESTX RSI(14) crossed below ${Number(level.toFixed(2))}`);
    expect(r.text).toContain(`closed at ${Number(curr.toFixed(1))} on Sep 30, 2026`);
    expect(r.text).toContain("adjusted closes");
    expect(r.href).toBe("/stocks/TESTX");
  });

  it("fires once per crossing: staying below the next session does not fire again", () => {
    const level = (prev + curr) / 2;
    const later = [...closes, 99];
    expect(rsi(later, 14).at(-1)!).toBeLessThan(level);
    expect(
      evaluateAlert(def("rsi_below", { level, period: 14 }), input({ series: series(later) })),
    ).toEqual({ fire: false, reason: "not_met" });
  });

  it("does not fire for a level the RSI was already below, or for the other direction", () => {
    expect(
      evaluateAlert(
        def("rsi_below", { level: curr - 1, period: 14 }),
        input({ series: series(closes) }),
      ).fire,
    ).toBe(false);
    expect(
      evaluateAlert(
        def("rsi_above", { level: (prev + curr) / 2, period: 14 }),
        input({ series: series(closes) }),
      ).fire,
    ).toBe(false);
  });

  it("crosses upward symmetrically", () => {
    const up = closes.map((c) => 300 - c);
    const u = rsi(up, 14);
    const level = (u.at(-2)! + u.at(-1)!) / 2;
    expect(
      evaluateAlert(def("rsi_above", { level, period: 14 }), input({ series: series(up) })).fire,
    ).toBe(true);
  });

  it("waits for the warm-up instead of inventing values", () => {
    expect(
      evaluateAlert(
        def("rsi_below", { level: 30, period: 14 }),
        input({ series: series(closes.slice(0, 15)) }),
      ),
    ).toEqual({ fire: false, reason: "no_data" });
    expect(evaluateAlert(def("rsi_below", { level: 30, period: 14 }), input()).fire).toBe(false);
  });
});

describe("moving-average crossings", () => {
  it("fires when the close crosses above its average", () => {
    const closes = [10, 10, 10, 10, 10, 9, 9, 9, 9, 9, 12];
    const r = evaluateAlert(
      def("sma_cross", { fast: 1, slow: 5, direction: "above" }),
      input({ series: series(closes) }),
    );
    expect(r).toMatchObject({ fire: true, key: "2026-09-30" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.subject).toBe("TESTX closed above its 5-day average");
    // SMA(5) of 9, 9, 9, 9, 12 is 9.60; the session before both were 9.00.
    expect(r.text).toBe(
      "TESTX closed at $12.00 on Sep 30, 2026, above its 5-day simple moving average of $9.60 " +
        "(the session before: $9.00 against $9.00). Closes adjusted for splits and dividends.",
    );
  });

  it("fires for a fast average crossing a slow one, once", () => {
    // SMA(2) vs SMA(4): 10.50 vs 11.00 the session before, 12.50 vs 11.50 on the last session.
    const closes = [13, 12, 11, 10, 11, 14];
    const cross = def("sma_cross", { fast: 2, slow: 4, direction: "above" });
    const r = evaluateAlert(cross, input({ series: series(closes) }));
    expect(r).toMatchObject({ fire: true, subject: "TESTX 2-day average crossed above the 4-day" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.text).toContain(
      "($12.50) crossed above its 4-day average ($11.50); the session before they were $10.50 and $11.00.",
    );
    expect(evaluateAlert(cross, input({ series: series([...closes, 15]) })).fire).toBe(false);
    expect(
      evaluateAlert(
        def("sma_cross", { fast: 2, slow: 4, direction: "below" }),
        input({ series: series(closes) }),
      ).fire,
    ).toBe(false);
  });

  it("needs the slow average's history", () => {
    expect(
      evaluateAlert(
        def("sma_cross", { fast: 1, slow: 5, direction: "above" }),
        input({ series: series([1, 2, 3, 4, 5]) }),
      ),
    ).toEqual({ fire: false, reason: "no_data" });
  });
});

describe("volume spikes", () => {
  const spike = def("volume_spike", { multiple: 2.5, lookback: 20 });
  const volumes = (last: number) => [...Array.from({ length: 25 }, () => 4_000_000), last];
  const closes = Array.from({ length: 26 }, () => 50);

  it("fires when the session's volume reaches the multiple of the previous sessions' average", () => {
    const r = evaluateAlert(spike, input({ series: series(closes, volumes(10_000_000)) }));
    expect(r).toMatchObject({ fire: true, key: "2026-09-30" });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.subject).toBe("TESTX volume 2.5× its 20-day average");
    expect(r.text).toBe(
      "TESTX traded 10M shares on Sep 30, 2026, 2.5 times its average of 4M over the previous " +
        "20 sessions (split-adjusted). Your threshold: 2.5×.",
    );
    expect(evaluateAlert(spike, input({ series: series(closes, volumes(9_999_000)) }))).toEqual({
      fire: false,
      reason: "not_met",
    });
  });

  it("averages only the sessions before the spike", () => {
    // Twenty sessions of 1M before the last; earlier heavy days fall outside the window.
    const v = [
      ...Array.from({ length: 5 }, () => 50_000_000),
      ...Array.from({ length: 20 }, () => 1_000_000),
      2_500_000,
    ];
    expect(evaluateAlert(spike, input({ series: series(closes, v) })).fire).toBe(true);
    expect(
      evaluateAlert(spike, input({ series: series(closes.slice(0, 20), v.slice(0, 20)) })),
    ).toEqual({ fire: false, reason: "no_data" });
  });
});

describe("new filings", () => {
  const created = new Date("2026-09-01T00:00:00Z");
  const filing = (n: number, form: string, stored = "2026-09-30T20:00:00Z"): FilingItem => ({
    accessionNo: `0000000042-26-00000${n}`,
    form,
    filedAt: new Date(created.getTime() + n * 3_600_000),
    filingDate: "2026-09-01",
    url: `https://www.sec.gov/Archives/edgar/data/42/${n}/doc.htm`,
    storedAt: new Date(stored),
  });
  const watch = (forms: string[], amendments = true) => def("new_filing", { forms, amendments });

  it("fires once for the matching filings, keyed by the latest, and remembers what it read", () => {
    const filings = [filing(1, "4"), filing(2, "8-K"), filing(3, "10-Q/A"), filing(4, "4")];
    const r = evaluateAlert(watch(["4", "10-Q"]), input({ filings }));
    expect(r).toMatchObject({
      fire: true,
      key: "0000000042-26-000004",
      date: "2026-09-01",
      subject: "3 new TESTX filings: Form 4, 10-Q/A",
      href: "https://www.sec.gov/Archives/edgar/data/42/4/doc.htm",
      state: { filingsSeenThrough: "2026-09-30T20:00:00.000Z" },
    });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.text.split("\n")).toEqual([
      "TESTX filed with the SEC:",
      "- Form 4, accepted Aug 31, 2026, 9:00 PM ET: https://www.sec.gov/Archives/edgar/data/42/1/doc.htm",
      "- 10-Q/A, accepted Aug 31, 2026, 11:00 PM ET: https://www.sec.gov/Archives/edgar/data/42/3/doc.htm",
      "- Form 4, accepted Sep 1, 2026, 12:00 AM ET: https://www.sec.gov/Archives/edgar/data/42/4/doc.htm",
    ]);
    // The in-app version leaves the links to the notification's own link.
    expect(r.summary).not.toContain("https://");
  });

  it("skips amendments when asked, and filings already read", () => {
    expect(
      evaluateAlert(watch(["10-Q"], false), input({ filings: [filing(3, "10-Q/A")] })),
    ).toEqual({
      fire: false,
      reason: "not_met",
      state: { filingsSeenThrough: "2026-09-30T20:00:00.000Z" },
    });
    const state = { filingsSeenThrough: "2026-09-30T20:00:00.000Z" };
    expect(evaluateAlert(watch(["4"]), input({ filings: [filing(1, "4")], state }))).toEqual({
      fire: false,
      reason: "not_met",
    });
    const later = filing(5, "4", "2026-09-30T20:00:01Z");
    expect(
      evaluateAlert(watch(["4"]), input({ filings: [filing(1, "4"), later], state })),
    ).toMatchObject({
      fire: true,
      key: later.accessionNo,
      subject: "New TESTX filing: Form 4",
    });
  });

  it("has no data for a company without an SEC registrant id", () => {
    expect(evaluateAlert(watch(["8-K"]), input({ filings: null }))).toEqual({
      fire: false,
      reason: "no_data",
    });
    expect(evaluateAlert(watch(["8-K"]), input({ filings: [] }))).toEqual({
      fire: false,
      reason: "not_met",
    });
  });

  it("keeps filings for later while snoozed or cooling down", () => {
    const filings = [filing(1, "8-K")];
    const snoozed = evaluateAlert(
      watch(["8-K"]),
      input({ filings, snoozedUntil: new Date(NOW.getTime() + 1) }),
    );
    expect(snoozed).toEqual({ fire: false, reason: "snoozed" });
    const cooling = evaluateAlert(
      watch(["8-K"]),
      input({ filings, lastFiredAt: new Date(NOW.getTime() - 3_600_000) }),
    );
    expect(cooling).toEqual({ fire: false, reason: "cooldown" });
  });
});

describe("screen results", () => {
  const change = (c: "enters" | "leaves" | "either") => def("screen_membership", { change: c });
  const m = (id: string) => ({ securityId: id, ticker: `T${id}` });
  const results = (ids: string[], over: Partial<ScreenResults> = {}): ScreenResults => ({
    screenId: "7",
    name: "Momentum",
    definition: "abc",
    asOf: "2026-09-30",
    members: ids.map(m),
    ...over,
  });
  const state = (ids: string[], definition = "abc") => ({
    screen: { definition, asOf: "2026-09-29", members: ids.map(m) },
  });

  it("takes the first results, or results after the screen changed, as the starting point", () => {
    const first = evaluateAlert(change("either"), input({ screen: results(["1", "2"]) }));
    expect(first).toMatchObject({
      fire: false,
      reason: "baseline",
      state: { screen: { definition: "abc", asOf: "2026-09-30", members: [m("1"), m("2")] } },
    });
    const edited = evaluateAlert(
      change("either"),
      input({ screen: results(["3"], { definition: "def" }), state: state(["1", "2"]) }),
    );
    expect(edited).toMatchObject({ fire: false, reason: "baseline" });
  });

  it("reports securities that entered and left", () => {
    const r = evaluateAlert(
      change("either"),
      input({ screen: results(["2", "3", "4"]), state: state(["1", "2"]) }),
    );
    expect(r).toMatchObject({
      fire: true,
      date: "2026-09-30",
      subject: "Screen “Momentum”: 2 entered, 1 left",
      href: "/screener?saved=7",
    });
    if (!r.fire) throw new Error("expected to fire");
    expect(r.key).toBe(`2026-09-30:${fingerprint("2,3,4")}`);
    expect(r.text).toBe(
      "As of Sep 30, 2026, your saved screen “Momentum” has 3 results.\nEntered: T3, T4.\nLeft: T1.",
    );
    expect(r.state?.screen?.members.map((x) => x.securityId)).toEqual(["2", "3", "4"]);
  });

  it("watches one direction when asked, moving the starting point for the other", () => {
    const leaving = input({ screen: results(["2"]), state: state(["1", "2"]) });
    expect(evaluateAlert(change("enters"), leaving)).toMatchObject({
      fire: false,
      reason: "not_met",
      state: { screen: { members: [m("2")] } },
    });
    expect(evaluateAlert(change("leaves"), leaving)).toMatchObject({
      fire: true,
      subject: "Screen “Momentum”: 1 left",
    });
    expect(
      evaluateAlert(
        change("either"),
        input({ screen: results(["1", "2"]), state: state(["1", "2"]) }),
      ),
    ).toEqual({
      fire: false,
      reason: "not_met",
    });
  });

  it("keeps the old starting point while cooling down, so the change is reported later", () => {
    const r = evaluateAlert(
      change("either"),
      input({
        screen: results(["1", "2", "3"]),
        state: state(["1", "2"]),
        lastFiredAt: new Date(NOW.getTime() - 3_600_000),
      }),
    );
    expect(r).toEqual({ fire: false, reason: "cooldown" });
  });

  it("is unavailable without results", () => {
    expect(evaluateAlert(change("either"), input())).toEqual({ fire: false, reason: "no_data" });
  });
});

describe("snoozing", () => {
  const above = def("price_above", { price: 100 });
  const crossing = { date: "2026-09-30", close: 101, prevDate: "2026-09-29", prevClose: 99 };

  it("holds a crossing until the snooze ends", () => {
    expect(
      evaluateAlert(
        above,
        input({ bar: crossing, snoozedUntil: new Date("2026-10-01T00:00:00Z") }),
      ),
    ).toEqual({ fire: false, reason: "snoozed" });
    expect(
      evaluateAlert(
        above,
        input({ bar: crossing, snoozedUntil: new Date("2026-09-30T20:59:59Z") }),
      ),
    ).toMatchObject({ fire: true, href: "/stocks/TESTX" });
  });
});

describe("definitions", () => {
  it("rejects impossible parameters", () => {
    const bad = [
      { kind: "sma_cross", params: { fast: 50, slow: 50, direction: "above" } },
      { kind: "sma_cross", params: { fast: 0, slow: 50, direction: "above" } },
      { kind: "rsi_below", params: { level: 100, period: 14 } },
      { kind: "rsi_above", params: { level: 30, period: 1 } },
      { kind: "volume_spike", params: { multiple: 1, lookback: 20 } },
      { kind: "new_filing", params: { forms: [], amendments: true } },
      { kind: "new_filing", params: { forms: ["10-K", "10-K"], amendments: true } },
      { kind: "new_filing", params: { forms: ["10-k"], amendments: true } },
      { kind: "new_filing", params: { forms: ["10-K/A"], amendments: true } },
      { kind: "screen_membership", params: { change: "stays" } },
    ];
    for (const b of bad)
      expect(AlertDefinition.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("describes each condition", () => {
    expect(describeAlert(def("rsi_below", { level: 30, period: 14 }))).toBe(
      "RSI(14) crosses below 30",
    );
    expect(describeAlert(def("sma_cross", { fast: 1, slow: 200, direction: "above" }))).toBe(
      "Close crosses above its 200-day average",
    );
    expect(describeAlert(def("sma_cross", { fast: 50, slow: 200, direction: "below" }))).toBe(
      "50-day average crosses below the 200-day average",
    );
    expect(describeAlert(def("volume_spike", { multiple: 2, lookback: 20 }))).toBe(
      "Volume at least 2× its 20-day average",
    );
    expect(
      describeAlert(def("new_filing", { forms: ["10-K", "4", "SC 13D"], amendments: true })),
    ).toBe("New filing: 10-K, Form 4, SC 13D (amendments too)");
    expect(
      describeAlert(def("screen_membership", { change: "enters" }), { screenName: "Momentum" }),
    ).toBe("A security enters “Momentum”");
  });

  it("reads stored state defensively", () => {
    expect(parseState(null)).toEqual({});
    expect(parseState({ filingsSeenThrough: "yesterday" })).toEqual({});
    expect(parseState({ filingsSeenThrough: "2026-09-30T20:00:00.000Z" })).toEqual({
      filingsSeenThrough: "2026-09-30T20:00:00.000Z",
    });
    expect(formName("4")).toBe("Form 4");
    expect(formName("13F-HR")).toBe("13F-HR");
  });
});
