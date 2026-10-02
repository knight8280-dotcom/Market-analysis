import "server-only";
import { resolveFlags, type FlagKey } from "@market/config";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "./db";

/** Every flag's effective state, read once per request. */
export const enabledFlags = cache(async (): Promise<Record<FlagKey, boolean>> => {
  const rows = await db().selectFrom("ops.feature_flags").select(["key", "enabled"]).execute();
  return resolveFlags(rows);
});

/** The owner's overrides, for the settings page. */
export async function flagOverrides(): Promise<Map<string, { enabled: boolean; updatedAt: Date }>> {
  const rows = await db()
    .selectFrom("ops.feature_flags")
    .select(["key", "enabled", "updated_at"])
    .execute();
  return new Map(rows.map((r) => [r.key, { enabled: r.enabled, updatedAt: r.updated_at }]));
}

export async function flagEnabled(key: FlagKey): Promise<boolean> {
  return (await enabledFlags())[key];
}

/** A feature that is switched off does not exist: its pages answer 404. */
export async function requireFlag(key: FlagKey): Promise<void> {
  if (!(await flagEnabled(key))) notFound();
}
