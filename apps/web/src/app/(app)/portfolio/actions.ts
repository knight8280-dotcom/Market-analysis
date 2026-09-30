"use server";

import { marketDateOf } from "@market/calendar";
import { OWNER_USER_ID } from "@market/config";
import {
  oversoldSells,
  parseTransactionsCsv,
  readTransaction,
  type CsvError,
  type CsvTx,
  type Tx,
} from "@market/portfolio";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { priceSource } from "../../../server/market";
import { portfolioTransactions, shareActions } from "../../../server/portfolio";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const idOf = (form: FormData, name: string) => {
  const v = text(form, name);
  return /^\d{1,18}$/.test(v) ? v : null;
};
const back = (portfolioId: string | null, params: Record<string, string> = {}) => {
  const q = new URLSearchParams({ ...(portfolioId ? { id: portfolioId } : {}), ...params });
  const s = q.toString();
  redirect(`/portfolio${s ? `?${s}` : ""}`);
};

async function owned(portfolioId: string | null): Promise<string | null> {
  if (!portfolioId) return null;
  const row = await db()
    .selectFrom("portfolios")
    .select("portfolio_id")
    .where("portfolio_id", "=", portfolioId)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  return row?.portfolio_id ?? null;
}

export async function createPortfolio(form: FormData): Promise<void> {
  await requireOwner();
  const name = text(form, "name").slice(0, 100);
  const benchmark = (text(form, "benchmark") || "SPY").toUpperCase().slice(0, 15);
  if (!name) back(null, { error: "name" });
  const row = await db()
    .insertInto("portfolios")
    .values({ user_id: OWNER_USER_ID, name, benchmark_ticker: benchmark })
    .onConflict((oc) => oc.columns(["user_id", "name"]).doUpdateSet({ updated_at: new Date() }))
    .returning("portfolio_id")
    .executeTakeFirstOrThrow();
  await audit("portfolio.create", { type: "portfolio", id: row.portfolio_id }, { name, benchmark });
  revalidatePath("/portfolio");
  back(row.portfolio_id);
}

export async function deletePortfolio(form: FormData): Promise<void> {
  await requireOwner();
  const id = await owned(idOf(form, "id"));
  if (id) {
    await db()
      .deleteFrom("portfolios")
      .where("portfolio_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .execute();
    await audit("portfolio.delete", { type: "portfolio", id });
  }
  revalidatePath("/portfolio");
  back(null);
}

/**
 * Resolves tickers, checks that no sell exceeds the shares held (with splits) and inserts all
 * rows in one database transaction, or nothing.
 */
async function insertTransactions(
  portfolioId: string,
  rows: readonly CsvTx[],
  source: "manual" | "csv",
): Promise<CsvError[]> {
  const database = db();
  const tickers = [...new Set(rows.flatMap((r) => (r.ticker ? [r.ticker] : [])))];
  const found = tickers.length
    ? await database
        .selectFrom("market.securities")
        .select(["security_id", "ticker"])
        .where("ticker", "in", tickers)
        .orderBy("is_active", "desc")
        .execute()
    : [];
  const idOfTicker = new Map<string, string>();
  for (const f of found) if (!idOfTicker.has(f.ticker)) idOfTicker.set(f.ticker, f.security_id);
  const errors: CsvError[] = rows
    .filter((r) => r.ticker && !idOfTicker.has(r.ticker))
    .map((r) => ({ line: r.line, message: `No security with ticker ${r.ticker} is loaded.` }));
  if (errors.length) return errors;

  const existing = await portfolioTransactions(portfolioId);
  const incoming: Tx[] = rows.map((r) => ({
    date: r.date,
    type: r.type,
    securityId: r.ticker ? idOfTicker.get(r.ticker)! : null,
    quantity: r.quantity,
    price: r.price,
    amount: r.amount,
    fees: r.fees,
  }));
  const px = await priceSource(database);
  const actions = px
    ? await shareActions(database, px, [
        ...new Set(incoming.flatMap((t) => (t.securityId ? [t.securityId] : []))),
      ])
    : [];
  const oversold = oversoldSells([...existing, ...incoming], actions).filter(
    (o) => o.index >= existing.length,
  );
  if (oversold.length) {
    return oversold.map((o) => {
      const r = rows[o.index - existing.length]!;
      return {
        line: r.line,
        message: `Sells ${r.quantity} ${r.ticker} on ${r.date}, but only ${Number(o.held.toFixed(6))} held then.`,
      };
    });
  }

  await database.transaction().execute(async (trx) => {
    await trx
      .insertInto("transactions")
      .values(
        rows.map((r, i) => ({
          portfolio_id: portfolioId,
          user_id: OWNER_USER_ID,
          security_id: incoming[i]!.securityId,
          type: r.type,
          trade_date: r.date,
          quantity: r.quantity === null ? null : String(r.quantity),
          price: r.price === null ? null : String(r.price),
          amount: r.amount === null ? null : String(r.amount),
          fees: String(r.fees),
          notes: r.notes,
          source,
        })),
      )
      .execute();
  });
  return [];
}

export type TxFormState = { ok: boolean; message: string | null; errors: CsvError[] };

export async function addTransaction(_prev: TxFormState, form: FormData): Promise<TxFormState> {
  await requireOwner();
  const id = await owned(idOf(form, "id"));
  if (!id) return { ok: false, message: "Choose a portfolio first.", errors: [] };
  const result = readTransaction((name) => text(form, name), 1, marketDateOf(new Date()));
  if ("error" in result) {
    return { ok: false, message: `Not added: ${result.error}`, errors: [] };
  }
  const errors = await insertTransactions(id, [result.row], "manual");
  if (errors.length) return { ok: false, message: `Not added: ${errors[0]!.message}`, errors: [] };
  await audit("transaction.create", { type: "portfolio", id }, { ...result.row });
  revalidatePath("/portfolio");
  return { ok: true, message: "Transaction added.", errors: [] };
}

const MAX_CSV_BYTES = 1_000_000;

export async function importTransactions(_prev: TxFormState, form: FormData): Promise<TxFormState> {
  await requireOwner();
  const id = await owned(idOf(form, "id"));
  if (!id) return { ok: false, message: "Choose a portfolio first.", errors: [] };
  const file = form.get("file");
  const pasted = text(form, "csv");
  let csv = pasted;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_CSV_BYTES) {
      return { ok: false, message: "The file is over 1 MB.", errors: [] };
    }
    csv = await file.text();
  }
  if (!csv) return { ok: false, message: "Choose a CSV file or paste its contents.", errors: [] };
  const { rows, errors } = parseTransactionsCsv(csv, { today: marketDateOf(new Date()) });
  if (errors.length) {
    return {
      ok: false,
      message: `Nothing imported: ${errors.length} ${errors.length === 1 ? "problem" : "problems"} to fix.`,
      errors,
    };
  }
  const problems = await insertTransactions(id, rows, "csv");
  if (problems.length) {
    return {
      ok: false,
      message: `Nothing imported: ${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix.`,
      errors: problems,
    };
  }
  await audit("transaction.import", { type: "portfolio", id }, { rows: rows.length });
  revalidatePath("/portfolio");
  return {
    ok: true,
    message: `Imported ${rows.length} ${rows.length === 1 ? "transaction" : "transactions"}.`,
    errors: [],
  };
}

export async function deleteTransaction(form: FormData): Promise<void> {
  await requireOwner();
  const portfolioId = await owned(idOf(form, "id"));
  const txId = idOf(form, "tx");
  if (portfolioId && txId) {
    const res = await db()
      .deleteFrom("transactions")
      .where("transaction_id", "=", txId)
      .where("portfolio_id", "=", portfolioId)
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirst();
    if (res.numDeletedRows > 0n) {
      await audit(
        "transaction.delete",
        { type: "portfolio", id: portfolioId },
        { transaction: txId },
      );
    }
  }
  revalidatePath("/portfolio");
  back(portfolioId);
}
