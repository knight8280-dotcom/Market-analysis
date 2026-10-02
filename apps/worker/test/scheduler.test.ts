import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE, dueJobs } from "../src/scheduler";

const ids = (iso: string, cfg = DEFAULT_SCHEDULE) =>
  dueJobs(new Date(iso), cfg).map((j) => j.jobId);
const eod = (iso: string) => ids(iso).find((id) => id.startsWith("schedule-eod/"));

describe("calendar-driven schedule", () => {
  it("requests EOD bars 30 minutes after the close", () => {
    // 2026-09-29 is a Tuesday; the close is 16:00 EDT = 20:00Z.
    expect(eod("2026-09-29T20:29:00Z")).toBe("schedule-eod/2026-09-28");
    expect(eod("2026-09-29T20:30:00Z")).toBe("schedule-eod/2026-09-29");
  });

  it("skips holidays: Thanksgiving evening still points at Wednesday", () => {
    expect(eod("2026-11-26T23:00:00Z")).toBe("schedule-eod/2026-11-25");
  });

  it("follows the 1:00 p.m. early close", () => {
    // 2026-11-27 closes at 13:00 EST = 18:00Z.
    expect(eod("2026-11-27T18:29:00Z")).toBe("schedule-eod/2026-11-25");
    expect(eod("2026-11-27T18:30:00Z")).toBe("schedule-eod/2026-11-27");
  });

  it("tracks both DST switches", () => {
    // Friday before DST (EST, close 21:00Z) and Monday after (EDT, close 20:00Z).
    expect(eod("2026-03-06T21:29:00Z")).toBe("schedule-eod/2026-03-05");
    expect(eod("2026-03-06T21:30:00Z")).toBe("schedule-eod/2026-03-06");
    expect(eod("2026-03-09T20:30:00Z")).toBe("schedule-eod/2026-03-09");
    // Week after DST ends.
    expect(eod("2026-11-02T21:29:00Z")).toBe("schedule-eod/2026-10-30");
    expect(eod("2026-11-02T21:30:00Z")).toBe("schedule-eod/2026-11-02");
  });

  it("runs the monitor every minute with a stable id", () => {
    expect(ids("2026-09-29T22:31:05Z")).toContain("staleness-monitor/2026-09-29T2231");
    expect(ids("2026-09-29T22:31:55Z")).toContain("staleness-monitor/2026-09-29T2231");
  });

  it("schedules daily jobs at their exchange-time hours", () => {
    const cfg = { ...DEFAULT_SCHEDULE, edgarEnabled: true, macroSeries: ["DGS10"] };
    // 01:59 EDT: nothing daily yet.
    const early = ids("2026-09-30T05:59:00Z", cfg);
    expect(early.some((id) => id.startsWith("reconcile-eod/"))).toBe(false);
    // 03:00 EDT: reconcile and partitions for 2026-09-30.
    const night = ids("2026-09-30T07:00:00Z", cfg);
    expect(night).toContain("reconcile-eod/2026-09-30");
    expect(night).toContain("ensure-partitions/2026-09-30");
    expect(night.some((id) => id.startsWith("ingest-macro/"))).toBe(false);
    // 18:44 / 18:45 EDT: the screener snapshot waits for the 18:30 end-of-day deadline.
    expect(ids("2026-09-30T22:44:00Z", cfg)).not.toContain("refresh-screener/2026-09-30");
    expect(ids("2026-09-30T22:45:00Z", cfg)).toContain("refresh-screener/2026-09-30");
    // 18:50 EDT: alerts, once the day's bars and snapshot are in.
    expect(ids("2026-09-30T22:49:00Z", cfg)).not.toContain("evaluate-alerts/2026-09-30");
    expect(ids("2026-09-30T22:50:00Z", cfg)).toContain("evaluate-alerts/2026-09-30");
    // 21:00 EDT: macro and the off-peak EDGAR sweep.
    const evening = ids("2026-10-01T01:00:00Z", cfg);
    expect(evening).toContain("ingest-macro/2026-09-30/DGS10");
    expect(evening).toContain("schedule-edgar/2026-09-30");
    // 22:30 EDT: Form 4 documents the evening's filings refresh did not read.
    expect(evening).not.toContain("sweep-insiders/2026-09-30");
    expect(ids("2026-10-01T02:30:00Z", cfg)).toContain("sweep-insiders/2026-09-30");
    // 23:00 EDT: one look at SEC's 13F data set listing.
    expect(ids("2026-10-01T02:30:00Z", cfg)).not.toContain("schedule-13f/2026-09-30");
    expect(ids("2026-10-01T03:00:00Z", cfg)).toContain("schedule-13f/2026-09-30");
    // 22:45 EDT: press releases in 8-Ks the filings refresh did not read.
    expect(ids("2026-10-01T02:44:00Z", cfg)).not.toContain("sweep-press-releases/2026-09-30");
    expect(ids("2026-10-01T02:45:00Z", cfg)).toContain("sweep-press-releases/2026-09-30");
    // 03:30 EDT: old news is deleted, whatever is configured.
    expect(ids("2026-09-30T07:29:00Z")).not.toContain("prune-news/2026-09-30");
    expect(ids("2026-09-30T07:30:00Z")).toContain("prune-news/2026-09-30");
  });

  it("rates news sentiment after each news read only when an Anthropic key is set", () => {
    const on = { ...DEFAULT_SCHEDULE, sentimentEnabled: true };
    const rate = (at: string, cfg = on) =>
      ids(at, cfg).filter((id) => id.startsWith("score-news-sentiment/"));
    expect(rate("2026-09-30T11:29:00Z")).toEqual([]);
    expect(rate("2026-09-30T11:30:00Z")).toEqual(["score-news-sentiment/2026-09-30/0730"]);
    expect(rate("2026-09-30T21:30:00Z")).toEqual(["score-news-sentiment/2026-09-30/1730"]);
    expect(rate("2026-10-01T03:30:00Z")).toEqual(["score-news-sentiment/2026-09-30/2330"]);
    expect(rate("2026-10-01T03:30:00Z", DEFAULT_SCHEDULE)).toEqual([]);
  });

  it("reads company news at 07:00 and 17:00 only when Finnhub is configured", () => {
    const on = { ...DEFAULT_SCHEDULE, newsEnabled: true };
    const news = (at: string, cfg = on) =>
      ids(at, cfg).filter((id) => id.startsWith("ingest-news/"));
    expect(news("2026-09-30T10:59:00Z")).toEqual([]);
    expect(news("2026-09-30T11:00:00Z")).toEqual(["ingest-news/2026-09-30/0700"]);
    expect(news("2026-09-30T20:59:00Z")).toEqual(["ingest-news/2026-09-30/0700"]);
    expect(news("2026-09-30T21:00:00Z")).toEqual(["ingest-news/2026-09-30/1700"]);
    expect(news("2026-09-30T21:00:00Z", DEFAULT_SCHEDULE)).toEqual([]);
  });

  it("checks FINRA short interest at 19:30 only when its credential is set", () => {
    const on = { ...DEFAULT_SCHEDULE, shortInterestEnabled: true };
    expect(ids("2026-09-30T23:29:00Z", on)).not.toContain("ingest-short-interest/2026-09-30");
    expect(ids("2026-09-30T23:30:00Z", on)).toContain("ingest-short-interest/2026-09-30");
    expect(ids("2026-09-30T23:30:00Z").some((id) => id.startsWith("ingest-short-interest/"))).toBe(
      false,
    );
  });

  it("omits EDGAR and macro when not configured", () => {
    const evening = ids("2026-10-01T01:00:00Z");
    expect(
      evening.some((id) => id.startsWith("schedule-edgar/") || id.startsWith("ingest-macro/")),
    ).toBe(false);
    expect(ids("2026-10-01T03:00:00Z").some((id) => id.startsWith("sweep-insiders/"))).toBe(false);
    expect(ids("2026-10-01T03:00:00Z").some((id) => id.startsWith("sweep-press-releases/"))).toBe(
      false,
    );
  });
});
