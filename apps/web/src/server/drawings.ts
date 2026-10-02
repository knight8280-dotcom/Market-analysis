import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { DrawingInput, type Drawing } from "../lib/chart/drawings";
import { db } from "./db";

/** The owner's drawings on a security's chart, oldest first; unreadable rows are skipped. */
export async function drawingsFor(securityId: string): Promise<Drawing[]> {
  const rows = await db()
    .selectFrom("chart_drawings")
    .select(["drawing_id", "kind", "basis", "points", "label"])
    .where("user_id", "=", OWNER_USER_ID)
    .where("security_id", "=", securityId)
    .orderBy("drawing_id")
    .execute();
  return rows.flatMap((r) => {
    const parsed = DrawingInput.safeParse({
      kind: r.kind,
      basis: r.basis,
      points: r.points,
      label: r.label ?? undefined,
    });
    return parsed.success ? [{ id: r.drawing_id, ...parsed.data }] : [];
  });
}
