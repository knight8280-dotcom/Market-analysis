import { loadWebEnv } from "@market/config";
import type { NextRequest } from "next/server";
import { ownerOr401 } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { assertDisplayable, priceSource, searchSecurities } from "../../../server/market";

/** Ticker search for the command palette. Owner only; never cached. */
export async function GET(request: NextRequest): Promise<Response> {
  const denied = await ownerOr401();
  if (denied) return denied;
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const database = db();
  const source = await priceSource(database);
  if (!source) return Response.json({ results: [] }, { headers: { "Cache-Control": "no-store" } });
  assertDisplayable(source, "securities", loadWebEnv().APP_ENV);
  const results = await searchSecurities(database, source, q);
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
