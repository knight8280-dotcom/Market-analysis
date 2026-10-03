"use server";

import {
  CooldownHours,
  OWNERSHIP_KINDS,
  PHASE2_KINDS,
  screenFingerprint,
  SNOOZE_HOURS,
  watchesScreen,
  type AlertKind,
  type AlertState,
} from "@market/alerts";
import { OWNER_USER_ID } from "@market/config";
import { Screen, screenMembers } from "@market/screener";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { channelsFrom, definitionFrom, isAlertKind, safeReturnPath } from "../../../lib/alert-form";
import { deleteOwnerAlert, snoozeOwnerAlert } from "../../../server/alert-changes";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { flagEnabled } from "../../../server/flags";
import { findSecurity } from "../../../server/market";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const back = (path: string, params: Record<string, string> = {}): never => {
  const q = new URLSearchParams(params).toString();
  redirect(`${path}${q ? `?${q}` : ""}`);
};

export async function createAlert(form: FormData): Promise<void> {
  await requireOwner();
  const kind = text(form, "kind");
  const ticker = text(form, "ticker").toUpperCase().slice(0, 15);
  const fail = (error: string): never =>
    back("/alerts", {
      error,
      ...(isAlertKind(kind) ? { kind } : {}),
      ...(ticker ? { ticker } : {}),
    });
  const phase2 = (PHASE2_KINDS as readonly AlertKind[]).includes(kind as AlertKind);
  const ownership = (OWNERSHIP_KINDS as readonly AlertKind[]).includes(kind as AlertKind);
  if (
    !isAlertKind(kind) ||
    (phase2 && !(await flagEnabled("alert_types"))) ||
    (ownership && !(await flagEnabled("ownership")))
  ) {
    fail("condition");
  }
  const def = definitionFrom(form) ?? fail("condition");
  const cooldown = CooldownHours.safeParse(Number(text(form, "cooldown") || Number.NaN));
  if (!cooldown.success) fail("cooldown");
  const channels = channelsFrom(form, await flagEnabled("push"));
  if (channels.length === 0) fail("channels");

  let securityId: string | null = null;
  let screenId: string | null = null;
  let state: AlertState = {};
  if (watchesScreen(def.kind)) {
    const id = text(form, "screen");
    const saved = /^\d{1,18}$/.test(id)
      ? await db()
          .selectFrom("saved_screens")
          .select(["screen_id", "definition"])
          .where("screen_id", "=", id)
          .where("user_id", "=", OWNER_USER_ID)
          .executeTakeFirst()
      : undefined;
    const screen = Screen.safeParse(saved?.definition);
    if (!saved || !screen.success) return fail("screen");
    screenId = saved.screen_id;
    // Today's results are the starting point: only later changes are reported.
    const { members, asOf } = await screenMembers(db(), screen.data);
    if (asOf) state = { screen: { definition: screenFingerprint(screen.data), asOf, members } };
  } else {
    const security = ticker ? await findSecurity(db(), ticker) : null;
    if (!security) return fail("ticker");
    // Form 4s are matched by the issuer's CIK.
    if (ownership && !security.cik) return fail("cik");
    securityId = security.securityId;
  }

  const row = await db()
    .insertInto("alerts")
    .values({
      user_id: OWNER_USER_ID,
      security_id: securityId,
      screen_id: screenId,
      kind: def.kind,
      params: JSON.stringify(def.params),
      cooldown_hours: cooldown.data!,
      state: JSON.stringify(state),
      channels,
    })
    .returning("alert_id")
    .executeTakeFirstOrThrow();
  await audit(
    "alert.create",
    { type: "alert", id: row.alert_id },
    { ...(ticker && securityId ? { ticker } : { screenId }), ...def, channels },
  );
  revalidatePath("/alerts");
  back("/alerts", { created: row.alert_id });
}

const alertId = (form: FormData) => {
  const v = text(form, "id");
  return /^\d{1,18}$/.test(v) ? v : null;
};

/** Snoozes for one of the offered spans, or ends a snooze (hours = 0). */
export async function snoozeAlert(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  const hours = Number(text(form, "hours"));
  const returnTo = safeReturnPath(text(form, "returnTo"));
  if (id && (hours === 0 || (SNOOZE_HOURS as readonly number[]).includes(hours))) {
    await snoozeOwnerAlert(id, hours);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function setAlertActive(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  const active = text(form, "active") === "true";
  const returnTo = safeReturnPath(text(form, "returnTo"));
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
  revalidatePath(returnTo);
  redirect(returnTo);
}

/** Deletes the alert with its events and notifications. */
export async function deleteAlert(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  const requested = safeReturnPath(text(form, "returnTo"));
  // The alert's own page is gone once it is deleted.
  const returnTo = id && requested === `/alerts/${id}` ? "/alerts" : requested;
  if (id) await deleteOwnerAlert(id);
  revalidatePath(returnTo);
  redirect(returnTo);
}

/** Email, push or both for an existing alert (Phase 2 step J2). */
export async function setAlertChannels(form: FormData): Promise<void> {
  await requireOwner();
  const id = alertId(form);
  const returnTo = safeReturnPath(text(form, "returnTo"));
  const channels = channelsFrom(form, await flagEnabled("push"));
  if (!id) redirect(returnTo);
  if (channels.length === 0) back(returnTo, { error: "channels" });
  const res = await db()
    .updateTable("alerts")
    .set({ channels, updated_at: new Date() })
    .where("alert_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  if (res.numUpdatedRows > 0n) {
    await audit("alert.channels", { type: "alert", id }, { channels });
  }
  revalidatePath(returnTo);
  back(returnTo, { saved: "channels" });
}
