import { loadWebEnv } from "@market/config";
import type { NextRequest } from "next/server";
import { buildIcs, type IcsEvent } from "../../../lib/ics";
import { ownerOr401 } from "../../../server/auth/owner";
import { actionsBetween, earningsBetween, releasesBetween } from "../../../server/calendars";
import { CALENDAR_TABS, calendarWindow, type CalendarTab } from "../../../server/calendar-view";
import { db } from "../../../server/db";
import { assertDisplayable, priceSource } from "../../../server/market";

const HOUR: Record<string, string> = {
  bmo: "before the open",
  amc: "after the close",
  dmh: "during market hours",
};

/**
 * The calendar tab as an .ics download (owner only). A download rather than a subscription
 * URL: calendar apps cannot sign in, and personal-plan data must not sit behind a guessable link.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await ownerOr401();
  if (denied) return denied;
  const t = request.nextUrl.searchParams.get("tab") ?? "earnings";
  const tab: CalendarTab = (CALENDAR_TABS as readonly string[]).includes(t)
    ? (t as CalendarTab)
    : "earnings";
  const all = request.nextUrl.searchParams.get("all") === "1";
  const { from, to } = calendarWindow(tab);
  const database = db();
  const appEnv = loadWebEnv().APP_ENV;
  let events: IcsEvent[];
  let name: string;

  if (tab === "earnings") {
    name = "Earnings";
    const rows = await earningsBetween(database, from, to);
    if (rows.some((r) => r.source === "finnhub")) assertDisplayable("finnhub", "earnings", appEnv);
    events = rows.map((r) => ({
      // Keyed by fiscal quarter when known, so a moved date updates the event on re-import.
      uid: `earnings-${r.ticker}-${r.fiscalYear && r.fiscalQuarter ? `${r.fiscalYear}q${r.fiscalQuarter}` : r.date}@market-analysis.local`,
      date: r.date,
      summary: `${r.ticker} earnings${r.hour ? ` (${HOUR[r.hour]})` : ""}`,
      description: [
        r.name,
        r.epsEstimate ? `EPS estimate ${r.epsEstimate}` : null,
        `Source: ${r.source === "finnhub" ? "Finnhub (personal use)" : "SEC 8-K Item 2.02"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    }));
  } else if (tab === "economic") {
    name = "Economic releases";
    const rows = (await releasesBetween(database, from, to)).filter((r) => all || r.major);
    events = rows.map((r) => ({
      uid: `release-${r.releaseId}-${r.date}@market-analysis.local`,
      date: r.date,
      summary: r.name,
      description:
        "Source: FRED. This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    }));
  } else {
    name = "Dividends and splits";
    const source = await priceSource(database);
    if (source) assertDisplayable(source, "corporate_actions", appEnv);
    const rows = source ? await actionsBetween(database, source, from, to) : [];
    events = rows.map((r) => ({
      uid: `action-${r.ticker}-${r.date}-${r.type}-${r.cashAmount ?? r.ratio ?? ""}@market-analysis.local`,
      date: r.date,
      summary: `${r.ticker} ${r.type.replaceAll("_", " ")}${r.cashAmount ? ` $${r.cashAmount}` : ""}`,
    }));
  }

  return new Response(buildIcs(`Market Analysis: ${name}`, events), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="market-analysis-${tab}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
