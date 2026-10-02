import { unreadNotifications } from "../../../../server/alerts";
import { ownerOr401 } from "../../../../server/auth/owner";
import { flagEnabled } from "../../../../server/flags";

export const dynamic = "force-dynamic";

/** The unread count for the header bell (Phase 2 step E3). GET /api/notifications/unread */
export async function GET(): Promise<Response> {
  const denied = await ownerOr401();
  if (denied) return denied;
  if (!(await flagEnabled("notifications"))) return new Response(null, { status: 404 });
  return Response.json(
    { unread: await unreadNotifications() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
