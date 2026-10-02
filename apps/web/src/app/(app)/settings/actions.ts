"use server";

import { isFlagKey } from "@market/config";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** Turns a feature on or off, overriding its default. */
export async function setFlag(form: FormData): Promise<void> {
  await requireOwner();
  const key = text(form, "key");
  const value = text(form, "enabled");
  if (isFlagKey(key) && (value === "true" || value === "false")) {
    const enabled = value === "true";
    await db()
      .insertInto("ops.feature_flags")
      .values({ key, enabled })
      .onConflict((oc) => oc.column("key").doUpdateSet({ enabled, updated_at: new Date() }))
      .execute();
    await audit("flag.set", { type: "feature_flag", id: key }, { enabled });
  }
  revalidatePath("/", "layout");
  redirect("/settings");
}

/** Removes the override, so the feature follows its default again. */
export async function resetFlag(form: FormData): Promise<void> {
  await requireOwner();
  const key = text(form, "key");
  if (isFlagKey(key)) {
    const res = await db()
      .deleteFrom("ops.feature_flags")
      .where("key", "=", key)
      .executeTakeFirst();
    if (res.numDeletedRows > 0n) await audit("flag.reset", { type: "feature_flag", id: key });
  }
  revalidatePath("/", "layout");
  redirect("/settings");
}
