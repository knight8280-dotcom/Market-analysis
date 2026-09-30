import { describe, expect, it } from "vitest";
import { buildIcs, fold } from "../src/lib/ics";

describe("buildIcs", () => {
  const ics = buildIcs(
    "Earnings",
    [
      {
        uid: "earnings-1-2026-10-20@market-analysis.local",
        date: "2026-10-20",
        summary: "TESTX earnings (after close)",
        description: "EPS estimate 1.25; source: Finnhub, personal use",
      },
    ],
    new Date("2026-09-30T12:00:00Z"),
  );

  it("writes a valid all-day event with CRLF line endings", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261020\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261021\r\n");
    expect(ics).toContain("DTSTAMP:20260930T120000Z\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
  });

  it("escapes commas and semicolons in text", () => {
    expect(ics).toContain("DESCRIPTION:EPS estimate 1.25\\; source: Finnhub\\, personal use");
  });

  it("folds long lines at 75 octets without splitting characters", () => {
    const long = `SUMMARY:${"é".repeat(60)}`;
    const folded = fold(long);
    for (const line of folded.split("\r\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});
