import { loadWebEnv } from "@market/config";
import type { NextRequest } from "next/server";
import { ownerOr401 } from "../../../../../server/auth/owner";
import { earningsDates } from "../../../../../server/calendars";
import { db } from "../../../../../server/db";
import {
  assertDisplayable,
  chartActions,
  dailySeries,
  findSecurity,
  lastUpdated,
  priceSource,
  sourceInfo,
} from "../../../../../server/market";

/** Benchmark for relative strength, when it is in the universe. */
const BENCHMARK = "SPY";
const NO_STORE = { "Cache-Control": "no-store" };

/** Chart data for one security: full daily history, corporate actions and the benchmark. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
): Promise<Response> {
  const denied = await ownerOr401();
  if (denied) return denied;
  const ticker = decodeURIComponent((await params).ticker).toUpperCase();
  const adjusted = request.nextUrl.searchParams.get("adjusted") !== "0";
  const database = db();
  const [security, source] = await Promise.all([
    findSecurity(database, ticker),
    priceSource(database),
  ]);
  if (!security || !source) {
    return Response.json({ error: "Unknown ticker" }, { status: 404, headers: NO_STORE });
  }
  assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const benchmark = ticker === BENCHMARK ? null : await findSecurity(database, BENCHMARK);
  const [bars, actions, updated, bench, earnings] = await Promise.all([
    dailySeries(database, security.securityId, source, adjusted),
    chartActions(database, security.securityId, source),
    lastUpdated(database, source),
    benchmark ? dailySeries(database, benchmark.securityId, source, true) : Promise.resolve([]),
    earningsDates(database, security.securityId, security.cik),
  ]);
  return Response.json(
    {
      ticker: security.ticker,
      currency: security.currency,
      adjusted,
      source: sourceInfo(source),
      asOf: bars.at(-1)?.[0] ?? null,
      fetchedAt: updated.loadedAt,
      bars,
      actions,
      earnings,
      benchmark: bench.length
        ? { ticker: BENCHMARK, closes: bench.map((b) => [b[0], b[4]]) }
        : null,
    },
    { headers: NO_STORE },
  );
}
