import { createHash } from "node:crypto";
import { isTradingDay, previousTradingDay } from "@market/calendar";
import { describe, expect, it } from "vitest";
import { computeAdjustmentFactors, factorFor } from "../src/adjustments";
import {
  SYNTHETIC_BACKFILL_END,
  SYNTHETIC_UNIVERSE_START,
  SyntheticProvider,
} from "../src/adapters/synthetic";
import { ProviderError } from "../src/errors";
import type { DailyBar } from "../src/types";
import { validateDailyBars } from "../src/validation";

const now = () => new Date("2026-09-30T12:00:00Z");
const provider = new SyntheticProvider({ now });
const all = { start: SYNTHETIC_UNIVERSE_START, end: SYNTHETIC_BACKFILL_END };
const bars = (symbol: string, range = all) => provider.getDailyBars({ symbol, ...range });
const hash = (b: DailyBar[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        b.map(({ date, open, high, low, close, volume }) => [date, open, high, low, close, volume]),
      ),
    )
    .digest("hex");

describe("synthetic universe", () => {
  it("has 500 labeled securities", async () => {
    const securities = await provider.getSecurities();
    expect(securities).toHaveLength(500);
    for (const s of securities) {
      expect(s.ticker.startsWith("TEST_")).toBe(true);
      expect(s.source).toBe("synthetic");
      expect(s.license_tier).toBe("synthetic");
    }
    expect(new Set(securities.map((s) => s.source_security_id)).size).toBe(500);
    expect(securities.filter((s) => s.asset_class === "etf").length).toBeGreaterThan(0);
  });

  it("is deterministic for a seed and different across seeds", async () => {
    const again = new SyntheticProvider({ now });
    const other = new SyntheticProvider({ now, seed: 7 });
    for (const symbol of ["TEST_S001", "TEST_SPLIT4", "TEST_DIV"]) {
      expect(hash(await again.getDailyBars({ symbol, ...all }))).toBe(hash(await bars(symbol)));
      expect(hash(await other.getDailyBars({ symbol, ...all }))).not.toBe(hash(await bars(symbol)));
    }
  });

  it("returns the same bars whether generated in one range or in pieces", async () => {
    const fresh = new SyntheticProvider({ now });
    const early = await fresh.getDailyBars({
      symbol: "TEST_S002",
      start: "2016-01-04",
      end: "2018-12-31",
    });
    const whole = await bars("TEST_S002");
    expect(hash(early)).toBe(hash(whole.filter((b) => b.date <= "2018-12-31")));
  });

  it("covers ten years of trading days and nothing after the latest closed session", async () => {
    const b = await bars("TEST_S001");
    expect(b[0]!.date).toBe("2016-01-04");
    expect(b.at(-1)!.date).toBe("2025-12-31");
    expect(b.length).toBeGreaterThan(2500);
    expect(b.every((x) => isTradingDay(x.date))).toBe(true);
    const future = await provider.getDailyBars({
      symbol: "TEST_S001",
      start: "2026-09-01",
      end: "2027-01-01",
    });
    expect(future.at(-1)!.date).toBe("2026-09-29");
  });
});

describe("scenario catalogue", () => {
  it("splits: raw price drops by the ratio on the ex-date and the action is reported", async () => {
    for (const [symbol, date, ratio] of [
      ["TEST_SPLIT4", "2020-08-31", 4],
      ["TEST_SPLIT20", "2022-07-18", 20],
      ["TEST_RSPLIT", "2023-05-15", 0.1],
    ] as const) {
      const b = await bars(symbol);
      const i = b.findIndex((x) => x.date === date);
      const rawMove = b[i]!.close / b[i - 1]!.close;
      expect(rawMove).toBeGreaterThan(0.7 / ratio);
      expect(rawMove).toBeLessThan(1.3 / ratio);
      const actions = await provider.getCorporateActions({ symbol, ...all });
      expect(actions).toMatchObject([{ type: "split", ex_date: date, ratio }]);

      // Adjusted for the split, the move is ordinary again.
      const closes = new Map(b.map((x) => [x.date, x.close]));
      const { factors } = computeAdjustmentFactors(
        actions,
        (d) => closes.get(previousTradingDay(d)) ?? null,
      );
      const adj = (x: DailyBar) => x.close * factorFor(x.date, factors).split;
      expect(Math.abs(adj(b[i]!) / adj(b[i - 1]!) - 1)).toBeLessThan(0.2);
    }
  });

  it("dividends: quarterly, special and stock dividends with realized amounts", async () => {
    const div = await provider.getCorporateActions({ symbol: "TEST_DIV", ...all });
    expect(div.length).toBeGreaterThanOrEqual(39);
    expect(div.every((a) => a.type === "cash_dividend" && a.cash_amount! > 0)).toBe(true);
    const special = await provider.getCorporateActions({ symbol: "TEST_SPECIAL", ...all });
    expect(special.find((a) => a.type === "special_dividend")?.ex_date).toBe("2021-12-15");
    const stock = await provider.getCorporateActions({ symbol: "TEST_STKDIV", ...all });
    expect(stock).toMatchObject([{ type: "stock_dividend", ex_date: "2019-06-17", ratio: 1.05 }]);
  });

  it("delisting, IPO and a reused ticker", async () => {
    expect((await bars("TEST_DELIST")).at(-1)!.date).toBe("2021-03-30");
    expect((await bars("TEST_IPO"))[0]!.date).toBe("2021-06-15");
    const reuse = await bars("TEST_REUSE");
    expect(reuse.some((b) => b.date >= "2019-07-01" && b.date < "2020-01-02")).toBe(false);
    expect(reuse.some((b) => b.date < "2019-07-01")).toBe(true);
    expect(reuse.some((b) => b.date >= "2020-01-02")).toBe(true);
    const holders = (await provider.getSecurities({ symbols: ["TEST_REUSE"] })).map(
      (s) => s.source_security_id,
    );
    expect(holders).toEqual(["SYN-REUSE-A", "SYN-REUSE-B"]);
  });

  it("symbol change: history and action", async () => {
    const [renamed] = await provider.getSecurities({ symbols: ["TEST_NEWNM"] });
    expect(renamed!.symbol_history.map((h) => h.ticker)).toEqual(["TEST_OLDNM", "TEST_NEWNM"]);
    const actions = await provider.getCorporateActions({ symbol: "TEST_NEWNM", ...all });
    expect(actions).toMatchObject([{ type: "symbol_change", ex_date: "2022-01-03" }]);
  });

  it("halt: no bars are invented for the halted days", async () => {
    const b = await bars("TEST_HALT", { start: "2018-05-04", end: "2018-05-10" });
    expect(b.map((x) => x.date)).toEqual(["2018-05-04", "2018-05-10"]);
  });

  it("bad data is rejected or flagged by the validator exactly where planted", async () => {
    const run = async (symbol: string) =>
      validateDailyBars(await bars(symbol), {
        previousClose: null,
        actionDates: new Set(),
        isTradingDay,
      });
    expect((await run("TEST_BADBAR")).issues).toMatchObject([
      { rule: "ohlc_inconsistent", date: "2019-10-10" },
    ]);
    expect((await run("TEST_NEGVOL")).issues).toMatchObject([
      { rule: "negative_volume", date: "2019-10-11" },
    ]);
    expect((await run("TEST_DUP")).issues).toMatchObject([
      { rule: "conflicting_duplicate_bar", date: "2024-02-01" },
    ]);
    expect((await run("TEST_JUMP")).issues).toMatchObject([
      { rule: "large_move_without_action", date: "2020-03-16" },
    ]);
    expect((await run("TEST_S001")).issues).toEqual([]);
  });

  it("spin-off is reported but has no ratio or cash", async () => {
    const actions = await provider.getCorporateActions({ symbol: "TEST_SPINOFF", ...all });
    expect(actions).toMatchObject([
      { type: "spin_off", ex_date: "2022-11-01", ratio: null, cash_amount: null },
    ]);
  });
});

describe("simulated outage", () => {
  it("rejects every call until cleared", async () => {
    const p = new SyntheticProvider({ now, universeSize: 20 });
    p.simulateOutage();
    await expect(p.getDailyBars({ symbol: "TEST_S001", ...all })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(p.healthCheck()).rejects.toMatchObject({ status: 503, retryable: true });
    p.simulateOutage(null);
    await expect(p.healthCheck()).resolves.toBeUndefined();
  });
});
