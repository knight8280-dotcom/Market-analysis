"use server";

import { checkRunRequest, type CheckedRequest } from "@market/backtest/request";
import { describeError } from "@market/backtest/schema";
import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { requireFlag } from "../../../server/flags";

/**
 * Backtest actions (Phase 2 step B8). Queueing only writes the request; the worker picks it up
 * within seconds, runs it in a worker thread and stores the results. The request is checked
 * here and again by the worker.
 */

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const idOf = (form: FormData, name: string) => {
  const v = text(form, name);
  return /^\d{1,18}$/.test(v) ? v : null;
};

async function guard() {
  await requireOwner();
  await requireFlag("backtests");
}

export interface QueueState {
  error: string | null;
}

/** Queues a run from the builder (useActionState); on success, opens its page. */
export async function queueBacktest(_prev: QueueState, form: FormData): Promise<QueueState> {
  await guard();
  const name = text(form, "name").slice(0, 100) || "Untitled strategy";
  let checked: CheckedRequest;
  try {
    checked = checkRunRequest(JSON.parse(text(form, "request")) as unknown);
  } catch (err) {
    return {
      error: err instanceof SyntaxError ? "The request is not valid JSON." : describeError(err),
    };
  }
  const database = db();
  let strategyId: string | null = null;
  if (form.get("save") === "on") {
    const saved = await database
      .insertInto("strategies")
      .values({
        user_id: OWNER_USER_ID,
        name,
        definition: JSON.stringify(checked.request.strategy),
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "name"]).doUpdateSet({
          definition: JSON.stringify(checked.request.strategy),
          updated_at: new Date(),
        }),
      )
      .returning("strategy_id")
      .executeTakeFirstOrThrow();
    strategyId = saved.strategy_id;
    await audit("strategy.save", { type: "strategy", id: strategyId }, { name });
  }
  const run = await database
    .insertInto("backtest_runs")
    .values({
      user_id: OWNER_USER_ID,
      strategy_id: strategyId,
      name,
      kind: checked.request.kind,
      request: JSON.stringify(checked.request),
    })
    .returning("run_id")
    .executeTakeFirstOrThrow();
  await audit(
    "backtest.queue",
    { type: "backtest_run", id: run.run_id },
    { name, kind: checked.request.kind, combinations: checked.combinations.length },
  );
  revalidatePath("/backtests");
  redirect(`/backtests/${run.run_id}`);
}

/** Queues the same request again (fresh data, same code): a reproducibility check. */
export async function rerunBacktest(form: FormData): Promise<void> {
  await guard();
  const id = idOf(form, "id");
  const database = db();
  const run = id
    ? await database
        .selectFrom("backtest_runs")
        .select(["name", "kind", "request", "strategy_id"])
        .where("run_id", "=", id)
        .where("user_id", "=", OWNER_USER_ID)
        .executeTakeFirst()
    : undefined;
  if (!run) redirect("/backtests");
  const again = await database
    .insertInto("backtest_runs")
    .values({
      user_id: OWNER_USER_ID,
      strategy_id: run.strategy_id,
      name: run.name,
      kind: run.kind,
      request: JSON.stringify(run.request),
    })
    .returning("run_id")
    .executeTakeFirstOrThrow();
  await audit("backtest.rerun", { type: "backtest_run", id: again.run_id }, { of: id });
  revalidatePath("/backtests");
  redirect(`/backtests/${again.run_id}`);
}

/** Cancels a run that has not started. */
export async function cancelBacktest(form: FormData): Promise<void> {
  await guard();
  const id = idOf(form, "id");
  if (id) {
    const done = await db()
      .updateTable("backtest_runs")
      .set({ status: "cancelled", finished_at: new Date() })
      .where("run_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (done.numUpdatedRows > 0n) await audit("backtest.cancel", { type: "backtest_run", id });
  }
  revalidatePath("/backtests");
  redirect(id ? `/backtests/${id}` : "/backtests");
}

export async function deleteBacktest(form: FormData): Promise<void> {
  await guard();
  const id = idOf(form, "id");
  if (id) {
    const done = await db()
      .deleteFrom("backtest_runs")
      .where("run_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .where("status", "!=", "running")
      .executeTakeFirst();
    if (done.numDeletedRows > 0n) await audit("backtest.delete", { type: "backtest_run", id });
  }
  revalidatePath("/backtests");
  redirect("/backtests");
}

export async function deleteStrategy(form: FormData): Promise<void> {
  await guard();
  const id = idOf(form, "id");
  if (id) {
    const done = await db()
      .deleteFrom("strategies")
      .where("strategy_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirst();
    if (done.numDeletedRows > 0n) await audit("strategy.delete", { type: "strategy", id });
  }
  revalidatePath("/backtests");
  redirect("/backtests");
}
