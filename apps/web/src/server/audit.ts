import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { db } from "./db";

/** Records a security-relevant or data-changing action in public.audit_logs. Never throws. */
export async function audit(
  action: string,
  entity?: { type: string; id?: string | number },
  details: Record<string, unknown> = {},
  userId: string | null = OWNER_USER_ID,
): Promise<void> {
  try {
    await db()
      .insertInto("audit_logs")
      .values({
        user_id: userId,
        action,
        entity: entity?.type ?? null,
        entity_id: entity?.id === undefined ? null : String(entity.id),
        details: JSON.stringify(details),
      })
      .execute();
  } catch {
    // Auditing must not break the action it records.
  }
}
