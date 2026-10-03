import { SNOOZE_HOURS } from "@market/alerts";
import { z } from "zod";
import { deleteOwnerAlert, snoozeOwnerAlert } from "../../../../server/alert-changes";
import { ownerOr401 } from "../../../../server/auth/owner";
import { isSameOrigin } from "../../../../server/auth/same-origin";

const NO_STORE = { "Cache-Control": "no-store" };
const Body = z.object({ action: z.enum(["snooze", "delete"]) });

/**
 * The buttons on a push notification (Phase 2 step J2): the service worker posts here with the
 * owner's session. "snooze" snoozes the alert for a day (the shortest snooze in the app);
 * "delete" deletes it, as on the alert's page.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await ownerOr401();
  if (denied) return denied;
  if (!isSameOrigin(request.headers)) {
    return Response.json({ error: "Not from this app" }, { status: 403, headers: NO_STORE });
  }
  const { id } = await params;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!/^\d{1,18}$/.test(id) || !body.success) {
    return Response.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  const done =
    body.data.action === "snooze"
      ? await snoozeOwnerAlert(id, SNOOZE_HOURS[0], "push")
      : await deleteOwnerAlert(id, "push");
  if (!done) return Response.json({ error: "No such alert" }, { status: 404, headers: NO_STORE });
  return Response.json({ ok: true, action: body.data.action }, { headers: NO_STORE });
}
