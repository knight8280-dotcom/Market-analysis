import { describe, expect, it } from "vitest";
import published from "./fixtures/nyse-published.json";
import {
  addDays,
  easterSunday,
  earlyClosesForYear,
  holidayOn,
  holidaysForYear,
  isTradingDay,
  latestClosedSession,
  latestSessionDueBy,
  marketDateOf,
  marketStatusAt,
  nextTradingDay,
  nthWeekday,
  lastWeekday,
  parseIsoDate,
  previousTradingDay,
  sessionFor,
  tradingDaysBetween,
  Weekday,
  zonedTimeToUtc,
} from "../src";

describe("date helpers", () => {
  it("rejects malformed and impossible dates", () => {
    expect(() => parseIsoDate("2026-9-30")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDate("2026-02-30")).toThrow(/Not a real calendar date/);
  });

  it("finds nth and last weekdays", () => {
    expect(nthWeekday(2026, 1, Weekday.Mon, 3)).toBe("2026-01-19");
    expect(nthWeekday(2026, 11, Weekday.Thu, 4)).toBe("2026-11-26");
    expect(lastWeekday(2026, 5, Weekday.Mon)).toBe("2026-05-25");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("computes Western Easter", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2028)).toBe("2028-04-16");
  });
});

describe("holidays and early closes match NYSE's published schedule", () => {
  for (const [year, dates] of Object.entries(published.holidays)) {
    it(`holidays ${year}`, () => {
      expect(holidaysForYear(Number(year)).map((h) => h.date)).toEqual(dates);
    });
  }
  for (const [year, dates] of Object.entries(published.earlyCloses)) {
    it(`early closes ${year}`, () => {
      expect(earlyClosesForYear(Number(year)).map((e) => e.date)).toEqual(dates);
    });
  }
});

describe("historical rules", () => {
  it("includes unscheduled closures", () => {
    for (const date of [
      "2001-09-11",
      "2001-09-14",
      "2004-06-11",
      "2007-01-02",
      "2012-10-29",
      "2012-10-30",
      "2018-12-05",
      "2025-01-09",
    ]) {
      expect(isTradingDay(date), date).toBe(false);
    }
  });

  it("does not observe a Saturday New Year's Day on the prior Friday", () => {
    expect(isTradingDay("2021-12-31")).toBe(true);
    expect(isTradingDay("2010-12-31")).toBe(true);
  });

  it("observes Sunday holidays on Monday", () => {
    expect(holidayOn("2023-01-02")?.name).toBe("New Year's Day");
    expect(holidayOn("2022-06-20")?.name).toBe("Juneteenth National Independence Day");
    expect(holidayOn("2022-12-26")?.name).toBe("Christmas Day");
  });

  it("only observes Juneteenth from 2022", () => {
    expect(isTradingDay("2021-06-18")).toBe(true);
  });

  it("applies the pre-2013 Friday-after-Independence-Day early close", () => {
    expect(earlyClosesForYear(2002).map((e) => e.date)).toContain("2002-07-05");
    expect(earlyClosesForYear(2013).map((e) => e.date)).toContain("2013-07-03");
    expect(earlyClosesForYear(2019).map((e) => e.date)).toContain("2019-07-03");
  });

  it("has no Christmas Eve early close when Dec 24 is a Friday holiday or a weekend", () => {
    expect(earlyClosesForYear(2021).map((e) => e.date)).not.toContain("2021-12-24");
    expect(earlyClosesForYear(2022).map((e) => e.date)).not.toContain("2022-12-23");
    expect(earlyClosesForYear(2018).map((e) => e.date)).toContain("2018-12-24");
  });

  it("counts trading days per year", () => {
    expect(tradingDaysBetween("2024-01-01", "2024-12-31")).toHaveLength(252);
    expect(tradingDaysBetween("2025-01-01", "2025-12-31")).toHaveLength(250);
  });

  it("refuses years outside its verified range", () => {
    expect(() => isTradingDay("1999-12-31")).toThrow(RangeError);
    expect(() => holidaysForYear(2031)).toThrow(RangeError);
  });
});

describe("sessions and time zones", () => {
  it("returns null for weekends and holidays", () => {
    expect(sessionFor("2026-10-03")).toBeNull();
    expect(sessionFor("2026-11-26")).toBeNull();
  });

  it("stores session times in UTC across both DST switches", () => {
    // DST begins 2026-03-08 and ends 2026-11-01 in New York.
    expect(sessionFor("2026-03-06")?.open.toISOString()).toBe("2026-03-06T14:30:00.000Z");
    expect(sessionFor("2026-03-09")?.open.toISOString()).toBe("2026-03-09T13:30:00.000Z");
    expect(sessionFor("2026-10-30")?.close.toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(sessionFor("2026-11-02")?.close.toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("closes at 1:00 p.m. ET on early-close days", () => {
    const s = sessionFor("2026-11-27");
    expect(s?.earlyClose).toBe(true);
    expect(s?.close.toISOString()).toBe("2026-11-27T18:00:00.000Z");
  });

  it("converts wall-clock times on DST transition days", () => {
    expect(zonedTimeToUtc("2026-03-08", "12:00").toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(zonedTimeToUtc("2026-11-01", "12:00").toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("walks to the next and previous trading day over holidays", () => {
    expect(nextTradingDay("2026-04-02")).toBe("2026-04-06");
    expect(previousTradingDay("2025-01-10")).toBe("2025-01-08");
    expect(previousTradingDay("2026-01-05")).toBe("2026-01-02");
  });

  it("uses the New York date, not the UTC date", () => {
    expect(marketDateOf(new Date("2026-01-02T03:00:00Z"))).toBe("2026-01-01");
    expect(marketDateOf(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
    expect(marketDateOf(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
  });

  it("reports market status", () => {
    expect(marketStatusAt(new Date("2026-09-29T13:29:59Z"))).toBe("pre_open");
    expect(marketStatusAt(new Date("2026-09-29T13:30:00Z"))).toBe("open");
    expect(marketStatusAt(new Date("2026-09-29T20:00:00Z"))).toBe("after_close");
    expect(marketStatusAt(new Date("2026-09-26T15:00:00Z"))).toBe("closed_day");
  });

  it("finds the latest closed session", () => {
    expect(latestClosedSession(new Date("2026-09-29T19:59:00Z")).date).toBe("2026-09-28");
    expect(latestClosedSession(new Date("2026-09-29T20:00:00Z")).date).toBe("2026-09-29");
    // Monday morning after a weekend: Friday.
    expect(latestClosedSession(new Date("2026-09-28T12:00:00Z")).date).toBe("2026-09-25");
  });

  it("finds the session whose EOD data is due by 6:30 p.m. ET", () => {
    expect(latestSessionDueBy(new Date("2026-09-29T22:29:00Z"), "18:30").date).toBe("2026-09-28");
    expect(latestSessionDueBy(new Date("2026-09-29T22:30:00Z"), "18:30").date).toBe("2026-09-29");
    // Early-close day: still due at 18:30 ET, not three hours after the 13:00 close.
    expect(latestSessionDueBy(new Date("2026-11-27T23:00:00Z"), "18:30").date).toBe("2026-11-25");
    expect(latestSessionDueBy(new Date("2026-11-27T23:30:00Z"), "18:30").date).toBe("2026-11-27");
  });
});
