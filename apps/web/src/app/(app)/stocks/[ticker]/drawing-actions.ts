"use server";

import { OWNER_USER_ID } from "@market/config";
import { DrawingInput, MAX_DRAWINGS, type Drawing } from "../../../../lib/chart/drawings";
import { requireOwner } from "../../../../server/auth/owner";
import { db } from "../../../../server/db";
import { flagEnabled } from "../../../../server/flags";
import { securityForTicker, tickerOf } from "../../../../server/stock";

export type DrawingResult = { ok: true; drawing: Drawing } | { ok: false; error: string };

/** Saves a drawing on a ticker's chart (Phase 2 step F1); called from the chart. */
export async function addDrawing(ticker: string, input: unknown): Promise<DrawingResult> {
  await requireOwner();
  if (!(await flagEnabled("drawings"))) return { ok: false, error: "Drawings are switched off." };
  const parsed = DrawingInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That drawing is not valid." };
  }
  const security = await securityForTicker(tickerOf(ticker));
  if (!security) return { ok: false, error: "Unknown ticker." };
  const d = parsed.data;
  const count = await db()
    .selectFrom("chart_drawings")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("user_id", "=", OWNER_USER_ID)
    .where("security_id", "=", security.securityId)
    .where("basis", "=", d.basis)
    .executeTakeFirst();
  if (Number(count?.n ?? 0) >= MAX_DRAWINGS) {
    return {
      ok: false,
      error: `A chart holds at most ${MAX_DRAWINGS} drawings; delete some first.`,
    };
  }
  const row = await db()
    .insertInto("chart_drawings")
    .values({
      user_id: OWNER_USER_ID,
      security_id: security.securityId,
      kind: d.kind,
      basis: d.basis,
      points: JSON.stringify(d.points),
      label: d.label ?? null,
    })
    .returning("drawing_id")
    .executeTakeFirstOrThrow();
  return { ok: true, drawing: { id: row.drawing_id, ...d } };
}

export async function removeDrawing(id: string): Promise<{ ok: boolean }> {
  await requireOwner();
  if (!/^\d{1,18}$/.test(id)) return { ok: false };
  const res = await db()
    .deleteFrom("chart_drawings")
    .where("drawing_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  return { ok: res.numDeletedRows > 0n };
}
