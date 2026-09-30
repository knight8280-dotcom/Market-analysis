"use client";

import { Button, Input } from "@market/ui";
import { useState } from "react";
import { createAlert } from "../app/(app)/alerts/actions";

const KINDS = [
  { id: "price_above", label: "Closes above a price" },
  { id: "price_below", label: "Closes below a price" },
  { id: "pct_move", label: "Moves by a percentage in a day" },
  { id: "earnings_upcoming", label: "Earnings coming up" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

const field = "flex flex-col gap-1 text-sm";
const select =
  "min-h-9 w-full rounded-md border bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** New-alert form: the fields follow the chosen condition. Server-validated on submit. */
export function AlertForm({ ticker }: { ticker?: string }) {
  const [kind, setKind] = useState<Kind>("price_above");
  return (
    <form
      action={createAlert}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[8rem_1fr_1fr_7rem_auto] lg:items-end"
    >
      <label className={field}>
        <span className="text-xs text-muted-foreground">Ticker</span>
        <Input
          name="ticker"
          defaultValue={ticker}
          required
          maxLength={15}
          autoCapitalize="characters"
          placeholder="AAPL"
        />
      </label>
      <label className={field}>
        <span className="text-xs text-muted-foreground">Condition</span>
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className={select}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {kind === "price_above" || kind === "price_below" ? (
        <label className={field}>
          <span className="text-xs text-muted-foreground">Price (USD)</span>
          <Input name="price" inputMode="decimal" required placeholder="200.00" />
        </label>
      ) : kind === "pct_move" ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={field}>
            <span className="text-xs text-muted-foreground">Move (%)</span>
            <Input name="pct" inputMode="decimal" required placeholder="5" />
          </label>
          <label className={field}>
            <span className="text-xs text-muted-foreground">Direction</span>
            <select name="direction" defaultValue="either" className={select}>
              <option value="either">Up or down</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
            </select>
          </label>
        </div>
      ) : (
        <label className={field}>
          <span className="text-xs text-muted-foreground">Within (days)</span>
          <Input name="days" type="number" min={1} max={30} required defaultValue={7} />
        </label>
      )}
      <label className={field}>
        <span className="text-xs text-muted-foreground">Cooldown (hours)</span>
        <Input name="cooldown" type="number" min={0} max={720} required defaultValue={24} />
      </label>
      <Button type="submit" variant="primary">
        Create alert
      </Button>
    </form>
  );
}
