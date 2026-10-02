"use client";

import { COPY } from "@market/compliance";
import { Button, cn, formatNumber, formatPercent, formatPrice, Input, MISSING } from "@market/ui";
import type { DcfInputs } from "@market/valuation";
import { runDcf, sensitivity, type DcfResult, type SensitivityGrid } from "@market/valuation";
import { useId, useState } from "react";
import {
  FIELDS,
  formOf,
  inputsOf,
  type FieldKey,
  type FormValues,
  type Sources,
} from "../../lib/valuation-form";

export type { FieldKey, FormValues, Sources };

/**
 * DCF calculator (Phase 2 step D2): every input editable, outputs recomputed in the browser on
 * each keystroke, a WACC × terminal sensitivity grid, and saved scenarios. Money is entered in
 * millions; rates in percent.
 */

const money = (v: number) => `${formatPrice(v / 1e6)}M`;

function Field({
  label,
  unit,
  value,
  onChange,
  source,
  testId,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  source?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label} <span className="font-normal">({unit})</span>
      </label>
      <Input
        id={id}
        value={value}
        inputMode="decimal"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className="w-36"
        data-testid={testId}
      />
      <p className="max-w-56 text-[11px] text-muted-foreground">{source ?? "Your assumption"}</p>
    </div>
  );
}

function Grid({ grid, perShare }: { grid: SensitivityGrid; perShare: boolean }) {
  const fmt = (v: number | null) =>
    v === null ? MISSING : perShare ? formatPrice(v) : `${formatNumber(v / 1e6, 0)}M`;
  const col = (c: number) =>
    grid.kind === "growth" ? formatPercent(c, 1) : `${formatNumber(c, 1)}×`;
  return (
    <div
      className="overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Sensitivity, scrollable"
    >
      <table
        className="w-full border-collapse text-sm"
        aria-label={`${perShare ? "Value per share" : "Equity value"} by discount rate and ${
          grid.kind === "growth" ? "terminal growth" : "exit multiple"
        }`}
      >
        <thead>
          <tr>
            <th
              scope="col"
              className="border-b px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              WACC ↓ / {grid.kind === "growth" ? "terminal growth" : "exit EV/EBITDA"} →
            </th>
            {grid.columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="border-b px-3 py-2 text-right text-xs font-medium text-muted-foreground"
              >
                {col(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.waccs.map((w, i) => (
            <tr key={w}>
              <th
                scope="row"
                className="border-b border-border/60 px-3 py-2 text-left text-xs font-medium"
              >
                {formatPercent(w, 1).replace("+", "")}
              </th>
              {grid.values[i]!.map((v, j) => (
                <td
                  key={grid.columns[j]}
                  className={cn(
                    "border-b border-border/60 px-3 py-2 text-right tabular-nums",
                    i === 2 &&
                      j === 2 &&
                      "font-semibold outline-2 -outline-offset-2 outline-primary",
                  )}
                >
                  {fmt(v)}
                  {i === 2 && j === 2 ? <span className="sr-only"> (your inputs)</span> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ScenarioItem {
  id: string;
  name: string;
  inputs: DcfInputs | null;
}

export function DcfCalculator({
  initial,
  sources,
  price,
  scenarios,
  securityId,
  saveAction,
  deleteAction,
}: {
  initial: FormValues;
  sources: Sources;
  price: { close: number; date: string } | null;
  scenarios: ScenarioItem[];
  securityId: string;
  saveAction: (form: FormData) => Promise<void>;
  deleteAction: (form: FormData) => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [scenarioName, setScenarioName] = useState("");
  const set = (k: FieldKey) => (v: string) => setValues((s) => ({ ...s, [k]: v }));

  const { inputs, problems } = inputsOf(values);
  let result: DcfResult | null = null;
  let grid: SensitivityGrid | null = null;
  if (inputs) {
    result = runDcf(inputs);
    grid = sensitivity(inputs);
  }
  const perShare = result?.perShare ?? null;

  return (
    <div className="flex flex-col gap-5">
      <p
        role="note"
        className="rounded-lg border border-warning/60 bg-warning/10 px-4 py-3 text-sm"
      >
        {COPY.valuationCalculator}
      </p>

      <fieldset className="flex flex-wrap items-start gap-4">
        <legend className="mb-2 text-sm font-medium">Inputs</legend>
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            unit={f.unit}
            value={values[f.key]}
            onChange={set(f.key)}
            source={sources[f.key]}
            testId={`dcf-input-${f.key}`}
          />
        ))}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground" id={`${securityId}-terminal`}>
            Terminal value
          </span>
          <div className="flex gap-1" role="radiogroup" aria-labelledby={`${securityId}-terminal`}>
            {(["growth", "multiple"] as const).map((m) => (
              <label
                key={m}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm",
                  values.method === m && "border-primary",
                )}
              >
                <input
                  type="radio"
                  name="terminal-method"
                  value={m}
                  checked={values.method === m}
                  onChange={() => setValues((s) => ({ ...s, method: m }))}
                  className="size-4"
                />
                {m === "growth" ? "Perpetual growth" : "Exit multiple"}
              </label>
            ))}
          </div>
        </div>
        {values.method === "growth" ? (
          <Field
            label="Terminal growth a year"
            unit="%"
            value={values.terminalGrowth}
            onChange={set("terminalGrowth")}
            testId="dcf-input-terminalGrowth"
          />
        ) : (
          <Field
            label="Exit EV/EBITDA"
            unit="×"
            value={values.evEbitda}
            onChange={set("evEbitda")}
            source={sources.evEbitda}
            testId="dcf-input-evEbitda"
          />
        )}
      </fieldset>

      {problems.length ? (
        <div role="alert" className="rounded-lg border border-down/60 p-3 text-sm">
          <p className="font-medium text-down">The model needs:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result ? (
        <section aria-label="Model output" className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">{COPY.valuationOutput}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border bg-surface p-3">
              <p className="text-xs text-muted-foreground">Value per share (model)</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="dcf-per-share">
                {perShare === null ? MISSING : formatPrice(perShare)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {perShare !== null && price
                  ? `${formatPercent(perShare / price.close - 1, 1)} vs the ${formatPrice(price.close)} close`
                  : perShare === null
                    ? "Needs a share count"
                    : "No price loaded"}
              </p>
            </div>
            <div className="rounded-lg border bg-surface p-3">
              <p className="text-xs text-muted-foreground">Equity value</p>
              <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="dcf-equity">
                {money(result.equityValue)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                enterprise value {money(result.enterpriseValue)} less net debt
              </p>
            </div>
            <div className="rounded-lg border bg-surface p-3">
              <p className="text-xs text-muted-foreground">Terminal value share</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatPercent(result.terminalShare, 1).replace("+", "")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">of the enterprise value</p>
            </div>
            <div className="rounded-lg border bg-surface p-3">
              <p className="text-xs text-muted-foreground">
                {values.method === "growth" ? "Implied exit EV/EBITDA" : "Implied perpetual growth"}
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {values.method === "growth"
                  ? result.impliedEvEbitda === null
                    ? MISSING
                    : `${formatNumber(result.impliedEvEbitda, 1)}×`
                  : result.impliedGrowth === null
                    ? MISSING
                    : formatPercent(result.impliedGrowth, 1)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                a cross-check of the terminal value
              </p>
            </div>
          </div>

          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Yearly cash flows, scrollable"
          >
            <table
              className="w-full border-collapse text-sm"
              aria-label="Yearly cash flows ($ millions)"
            >
              <thead>
                <tr>
                  {[
                    "Year",
                    "Revenue",
                    "EBIT",
                    "After tax",
                    "D&A",
                    "Capex",
                    "Working capital",
                    "Free cash flow",
                    "Present value",
                  ].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={cn(
                        "border-b px-3 py-2 text-xs font-medium text-muted-foreground",
                        i ? "text-right" : "text-left",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.year}>
                    <th
                      scope="row"
                      className="border-b border-border/60 px-3 py-2 text-left font-medium"
                    >
                      {r.year}
                    </th>
                    {[
                      r.revenue,
                      r.ebit,
                      r.nopat,
                      r.da,
                      -r.capex,
                      -r.changeNwc,
                      r.fcf,
                      r.presentValue,
                    ].map((v, i) => (
                      <td
                        key={i}
                        className="border-b border-border/60 px-3 py-2 text-right tabular-nums"
                      >
                        {formatNumber(v / 1e6 || 0, 1).replace("-", "−")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Cash flows are discounted at the end of each year. Terminal value{" "}
            {values.method === "growth"
              ? "is year N+1's free cash flow ÷ (WACC − terminal growth)"
              : "is year N's EBITDA × the exit multiple"}
            , discounted from year N: {money(result.terminalValue)}, worth{" "}
            {money(result.pvTerminal)} today.
          </p>

          {grid ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Sensitivity</h3>
              <Grid grid={grid} perShare={perShare !== null} />
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Saved scenarios" className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Scenarios</h3>
        <form action={saveAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="securityId" value={securityId} />
          <input type="hidden" name="inputs" value={inputs ? JSON.stringify(inputs) : ""} />
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Scenario name
            <Input
              name="name"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              maxLength={100}
              required
              className="w-56"
            />
          </label>
          <Button type="submit" variant="secondary" disabled={!inputs}>
            Save these inputs
          </Button>
        </form>
        {scenarios.length ? (
          <ul className="flex flex-col divide-y text-sm" aria-label="Saved scenarios list">
            {scenarios.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{s.name}</span>
                <span className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!s.inputs}
                    onClick={() => s.inputs && setValues(formOf(s.inputs))}
                    aria-label={`Load scenario ${s.name}`}
                  >
                    Load
                  </Button>
                  <form action={deleteAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete scenario ${s.name}`}
                    >
                      Delete
                    </Button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No saved scenarios for this security yet.</p>
        )}
      </section>
    </div>
  );
}
