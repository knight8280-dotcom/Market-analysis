"use client";

import { Button, Input } from "@market/ui";
import { useActionState, useState } from "react";
import { addTransaction, type TxFormState } from "../../app/(app)/portfolio/actions";

const TYPES = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "dividend", label: "Dividend" },
  { id: "deposit", label: "Deposit" },
  { id: "withdrawal", label: "Withdrawal" },
  { id: "fee", label: "Fee" },
] as const;
type TypeId = (typeof TYPES)[number]["id"];

const field = "flex flex-col gap-1 text-sm";
const hint = "text-xs text-muted-foreground";
const select =
  "min-h-9 w-full rounded-md border bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const initial: TxFormState = { ok: false, message: null, errors: [] };

/** Manual entry; the fields follow the type. Validated on the server with the CSV rules. */
export function TransactionForm({ portfolioId, today }: { portfolioId: string; today: string }) {
  const [type, setType] = useState<TypeId>("buy");
  const [state, action, pending] = useActionState(addTransaction, initial);
  const trade = type === "buy" || type === "sell";
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={portfolioId} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className={field}>
          <span className={hint}>Type</span>
          <select
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as TypeId)}
            className={select}
          >
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          <span className={hint}>Date</span>
          <Input name="date" type="date" required max={today} defaultValue={today} />
        </label>
        {trade || type === "dividend" ? (
          <label className={field}>
            <span className={hint}>Ticker{type === "dividend" ? " (optional)" : ""}</span>
            <Input name="ticker" required={trade} maxLength={15} autoCapitalize="characters" />
          </label>
        ) : null}
        {trade ? (
          <>
            <label className={field}>
              <span className={hint}>Quantity</span>
              <Input name="quantity" inputMode="decimal" required />
            </label>
            <label className={field}>
              <span className={hint}>Price (USD)</span>
              <Input name="price" inputMode="decimal" required />
            </label>
          </>
        ) : (
          <label className={field}>
            <span className={hint}>Amount (USD)</span>
            <Input name="amount" inputMode="decimal" required />
          </label>
        )}
        {type !== "fee" && type !== "deposit" && type !== "withdrawal" ? (
          <label className={field}>
            <span className={hint}>Fees (USD)</span>
            <Input name="fees" inputMode="decimal" placeholder="0" />
          </label>
        ) : null}
      </div>
      <label className={field}>
        <span className={hint}>Notes (optional)</span>
        <Input name="notes" maxLength={500} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          Add transaction
        </Button>
        {state.message ? (
          <p
            role={state.ok ? "status" : "alert"}
            className={state.ok ? "text-sm text-up" : "text-sm text-down"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
