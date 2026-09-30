"use client";

import { Button } from "@market/ui";
import { Download } from "lucide-react";
import { useActionState } from "react";
import { importTransactions, type TxFormState } from "../../app/(app)/portfolio/actions";

const initial: TxFormState = { ok: false, message: null, errors: [] };

/**
 * CSV import: a file or pasted text. All rows go in together or none do; problems are listed
 * by line so the file can be fixed and imported again.
 */
export function ImportForm({ portfolioId, template }: { portfolioId: string; template: string }) {
  const [state, action, pending] = useActionState(importTransactions, initial);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={portfolioId} />
      <p className="text-sm text-muted-foreground">
        Columns: <code>date,type,ticker,quantity,price,amount,fees,notes</code>. Types: buy, sell,
        dividend, deposit, withdrawal, fee. Dates as YYYY-MM-DD; quantities and prices as traded
        (splits are applied for you).{" "}
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
          download="transactions-template.csv"
          className="inline-flex items-center gap-1 text-primary underline"
        >
          <Download aria-hidden className="size-3.5" />
          Template
        </a>
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">CSV file (up to 1 MB)</span>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          className="text-sm file:mr-3 file:min-h-9 file:rounded-md file:border file:bg-muted file:px-3 file:text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">Or paste CSV</span>
        <textarea
          name="csv"
          rows={4}
          spellCheck={false}
          className="rounded-md border bg-background p-2 font-mono text-xs"
          placeholder="date,type,ticker,quantity,price,amount,fees,notes"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Import
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
      {state.errors.length ? (
        <ul aria-label="Import problems" className="flex flex-col gap-1 text-sm">
          {state.errors.slice(0, 50).map((e) => (
            <li key={`${e.line}-${e.message}`}>
              <span className="font-medium">Line {e.line}:</span> {e.message}
            </li>
          ))}
          {state.errors.length > 50 ? (
            <li className="text-muted-foreground">…and {state.errors.length - 50} more.</li>
          ) : null}
        </ul>
      ) : null}
    </form>
  );
}
