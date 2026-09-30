"use server";

import { AlertDefinition, CooldownHours } from "@market/alerts";
import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { findSecurity } from "../../../server/market";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const num = (form: FormData, name: string) => {
  const v = text(form, name).replace(/[$,%\s]/g, "");
  return v === "" ? Number.NaN : Number(v);
};
const back = (params: Record<string, string> = {}) => {
  const q = new URLSearchParams(params).toString();
  redirect(`/alerts${q ? `?${q}` : ""}`);
};

/** Builds the definition from the form; percentages are entered as percent (5 = 5%). */
function definitionFrom(form: FormData): AlertDefinition | null {
  const kind = text(form, "kind");
  const raw =
    kind === "price_above" || kind === "price_below"
      ? { kind, params: { price: num(form, "price") } }
      : kind === "pct_move"
        ? {
            kind,
            params: { pct: num(form, "pct") / 100, direction: text(form, "direction") || "either" },
          }
        : kind === "earnings_upcoming"
          ? { kind, params: { days: num(form, "days") } }
          : null;
  const parsed = AlertDefinition.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function createAlert(form: FormData): Promise<void> {
  await requireOwner();
  const ticker = text(form, "ticker").toUpperCase().slice(0, 15);
  const security = ticker ? await findSecurity(db(), ticker) : null;
  if (!security) back({ error: "ticker", ticker });
  const def = definitionFrom(form);
  if (!def) back({ error: "condition", ticker });
  const cooldown = CooldownHours.safeParse(num(form, "cooldown"));
  if (!cooldown.success) back({ error: "cooldown", ticker });
  const row = await db()
    .insertInto("alerts")
    .values({
      user_id: OWNER_USER_ID,
      security_id: security!.securityId,
      kind: def!.kind,
      params: JSON.stringify(def!.params),
      cooldown_hours: cooldown.data!,
    })
    .returning("alert_id")
    .executeTakeFirstOrThrow();
  await audit("alert.create", { type: "alert", id: row.alert_id }, { ticker, ...def! });
  revalidatePath("/alerts");
  back({ created: row.alert_id });
}

const alertId = (form: FormData) => {
  const v = text(form, "id");
  return /^\d{1,18}$/.test(v) ? v : null;
};

export async function setAlertActive(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  const active = text(form, "active") === "true";
  if (id) {
    const res = await db()
      .updateTable("alerts")
      .set({ active, updated_at: new Date() })
      .where("alert_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirst();
    if (res.numUpdatedRows > 0n) {
      await audit(active ? "alert.resume" : "alert.pause", { type: "alert", id });
    }
  }
  revalidatePath("/alerts");
  back();
}

export async function deleteAlert(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  if (id) {
    const res = await db()
      .deleteFrom("alerts")
      .where("alert_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirst();
    if (res.numDeletedRows > 0n) await audit("alert.delete", { type: "alert", id });
  }
  revalidatePath("/alerts");
  back();
}
