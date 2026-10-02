"use server";

import { OWNER_USER_ID } from "@market/config";
import { DcfInputs } from "@market/valuation";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../../../server/audit";
import { requireOwner } from "../../../../../server/auth/owner";
import { db } from "../../../../../server/db";
import { requireFlag } from "../../../../../server/flags";

/** Saved DCF scenarios (Phase 2 step D2): inputs only; outputs are recomputed on load. */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const idOf = (form: FormData, name: string) => {
  const v = text(form, name);
  return /^\d{1,18}$/.test(v) ? v : null;
};

async function back(securityId: string | null, params: Record<string, string> = {}) {
  const row = securityId
    ? await db()
        .selectFrom("market.securities")
        .select("ticker")
        .where("security_id", "=", securityId)
        .executeTakeFirst()
    : undefined;
  if (!row) redirect("/");
  const q = new URLSearchParams(params).toString();
  redirect(`/stocks/${encodeURIComponent(row.ticker)}/valuation${q ? `?${q}` : ""}`);
}

export async function saveScenario(form: FormData): Promise<void> {
  await requireOwner();
  await requireFlag("valuation");
  const securityId = idOf(form, "securityId");
  const name = text(form, "name").slice(0, 100);
  let inputs: DcfInputs;
  try {
    inputs = DcfInputs.parse(JSON.parse(text(form, "inputs")) as unknown);
  } catch {
    return back(securityId, { saved: "invalid" });
  }
  if (!securityId || !name) return back(securityId, { saved: "invalid" });
  const row = await db()
    .insertInto("valuation_scenarios")
    .values({
      user_id: OWNER_USER_ID,
      security_id: securityId,
      name,
      inputs: JSON.stringify(inputs),
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "security_id", "name"])
        .doUpdateSet({ inputs: JSON.stringify(inputs), updated_at: new Date() }),
    )
    .returning("scenario_id")
    .executeTakeFirstOrThrow();
  await audit("valuation.save", { type: "valuation_scenario", id: row.scenario_id }, { name });
  revalidatePath("/stocks/[ticker]/valuation", "page");
  return back(securityId, { saved: "1" });
}

export async function deleteScenario(form: FormData): Promise<void> {
  await requireOwner();
  await requireFlag("valuation");
  const id = idOf(form, "id");
  const row = id
    ? await db()
        .deleteFrom("valuation_scenarios")
        .where("scenario_id", "=", id)
        .where("user_id", "=", OWNER_USER_ID)
        .returning("security_id")
        .executeTakeFirst()
    : undefined;
  if (row) await audit("valuation.delete", { type: "valuation_scenario", id: id! });
  revalidatePath("/stocks/[ticker]/valuation", "page");
  return back(row?.security_id ?? null);
}
