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
    // 21:00 EDT: macro and the off-peak EDGAR sweep.
    const evening = ids("2026-10-01T01:00:00Z", cfg);
    expect(evening).toContain("ingest-macro/2026-09-30/DGS10");
    expect(evening).toContain("schedule-edgar/2026-09-30");
  });

  it("omits EDGAR and macro when not configured", () => {
    const evening = ids("2026-10-01T01:00:00Z");
    expect(
      evening.some((id) => id.startsWith("schedule-edgar/") || id.startsWith("ingest-macro/")),
    ).toBe(false);
  });
});
