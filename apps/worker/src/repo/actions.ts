import type { IsoDate } from "@market/calendar";
import { sql, type Database } from "@market/db";
import type { CorporateAction, CorporateActionType, ProviderId } from "@market/market-data";

/** Inserts new actions and updates changed ones; returns how many rows changed. */
export async function upsertActions(
  db: Database,
  securityId: string,
  actions: readonly CorporateAction[],
): Promise<number> {
  let changed = 0;
  for (const a of actions) {
    const result = await sql`
      insert into market.corporate_actions
        (security_id, type, ex_date, ratio, cash_amount, currency, record_date, pay_date, details, source)
      values (${securityId}, ${a.type}, ${a.ex_date}, ${a.ratio}, ${a.cash_amount}, ${a.currency},
              ${a.record_date}, ${a.pay_date}, ${JSON.stringify(a.details)}::jsonb, ${a.source})
      on conflict (security_id, type, ex_date, source) do update
        set ratio = excluded.ratio, cash_amount = excluded.cash_amount, currency = excluded.currency,
            record_date = excluded.record_date, pay_date = excluded.pay_date,
            details = excluded.details, ingested_at = now()
        where (market.corporate_actions.ratio, market.corporate_actions.cash_amount, market.corporate_actions.details)
          is distinct from (excluded.ratio, excluded.cash_amount, excluded.details)
    `.execute(db);
    changed += Number(result.numAffectedRows ?? 0);
  }
  return changed;
}

export interface StoredAction {
  type: CorporateActionType;
  ex_date: IsoDate;
  ratio: number | null;
  cash_amount: number | null;
  source: ProviderId;
}

export async function actionsFor(db: Database, securityId: string): Promise<StoredAction[]> {
  const rows = await db
    .selectFrom("market.corporate_actions")
    .select(["type", "ex_date", "ratio", "cash_amount", "source"])
    .where("security_id", "=", securityId)
    .orderBy("ex_date")
    .execute();
  return rows.map((r) => ({
    type: r.type as CorporateActionType,
    ex_date: r.ex_date,
    ratio: r.ratio === null ? null : Number(r.ratio),
    cash_amount: r.cash_amount === null ? null : Number(r.cash_amount),
    source: r.source as ProviderId,
  }));
}

export async function replaceFactors(
  db: Database,
  securityId: string,
  rows: readonly { ex_date: IsoDate; split_factor: number; dividend_factor: number }[],
  at: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("market.adjustment_factors")
      .where("security_id", "=", securityId)
      .execute();
    if (rows.length > 0) {
      await trx
        .insertInto("market.adjustment_factors")
        .values(rows.map((r) => ({ security_id: securityId, ...r, computed_at: at })))
        .execute();
    }
  });
}
