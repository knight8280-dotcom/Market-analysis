"use server";

import { OWNER_USER_ID } from "@market/config";
import { parseScreen } from "@market/screener";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { encodeScreen } from "../../../server/screens";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** Saves (or replaces, by name) the current screen for the owner. */
export async function saveScreen(form: FormData): Promise<void> {
  await requireOwner();
  const name = text(form, "name").trim().slice(0, 100);
  const screen = parseScreen(JSON.parse(text(form, "screen") || "{}"));
  if (!name) redirect(`/screener?s=${encodeScreen(screen)}&error=name`);
  const row = await db()
    .insertInto("saved_screens")
    .values({ user_id: OWNER_USER_ID, name, definition: JSON.stringify(screen) })
    .onConflict((oc) =>
      oc.columns(["user_id", "name"]).doUpdateSet({
        definition: JSON.stringify(screen),
        updated_at: new Date(),
      }),
    )
    .returning("screen_id")
    .executeTakeFirstOrThrow();
  await audit("saved_screen.save", { type: "saved_screen", id: row.screen_id }, { name });
  revalidatePath("/screener");
  redirect(`/screener?saved=${row.screen_id}`);
}

export async function deleteScreen(form: FormData): Promise<void> {
  await requireOwner();
  const id = text(form, "id");
  if (!/^\d+$/.test(id)) redirect("/screener");
  await db()
    .deleteFrom("saved_screens")
    .where("screen_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .execute();
  await audit("saved_screen.delete", { type: "saved_screen", id });
  revalidatePath("/screener");
  redirect("/screener");
}
