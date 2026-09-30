"use client";

import { FIELD_IDS, fieldDef, type FieldId } from "@market/screener/fields";
import { Screen, type Condition } from "@market/screener/schema";
import { Button, Input } from "@market/ui";
import { Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Filter builder for the screener. Each row is a field, an operator and a value (or another
 * field to compare with). Percent fields take percent (5 = 5%), market cap takes $ billions and
 * volume millions of shares; the screen stores plain units. The screen is validated with the same
 * schema the server uses before it goes into the URL.
 */
type OpChoice =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "above_field"
  | "below_field"
  | "eq"
  | "neq"
  | "in"
  | "not_null"
  | "is_null";

interface Row {
  key: number;
  field: FieldId;
  op: OpChoice;
  a: string;
  b: string;
  ref: FieldId;
  values: string[];
}

const NUMBER_OPS: [OpChoice, string][] = [
  ["gt", "above"],
  ["gte", "at least"],
  ["lt", "below"],
  ["lte", "at most"],
  ["between", "between"],
  ["above_field", "above field"],
  ["below_field", "below field"],
  ["not_null", "has a value"],
  ["is_null", "is empty"],
];
const ENUM_OPS: [OpChoice, string][] = [
  ["in", "is one of"],
  ["eq", "is"],
  ["neq", "is not"],
];
const TEXT_OPS: [OpChoice, string][] = [
  ["eq", "is"],
  ["neq", "is not"],
];

/** Multiplier from what the user types to the stored unit, and its label. */
function inputScale(field: FieldId): { factor: number; unit: string } {
  if (field === "market_cap") return { factor: 1e9, unit: "$B" };
  if (field === "avg_volume_30d") return { factor: 1e6, unit: "M sh" };
  if (fieldDef(field).format === "percent") return { factor: 0.01, unit: "%" };
  return { factor: 1, unit: "" };
}

const toInput = (field: FieldId, v: number) =>
  String(Number((v / inputScale(field).factor).toPrecision(12)));
const fromInput = (field: FieldId, s: string) => Number(s) * inputScale(field).factor;

let nextKey = 1;
function toRow(c: Condition): Row {
  const base: Row = {
    key: nextKey++,
    field: c.field,
    op: c.op,
    a: "",
    b: "",
    ref: "sma200",
    values: [],
  };
  if (c.ref)
    return {
      ...base,
      ref: c.ref,
      op: c.op === "gt" || c.op === "gte" ? "above_field" : "below_field",
    };
  if (Array.isArray(c.value) && typeof c.value[0] === "number") {
    return { ...base, a: toInput(c.field, c.value[0]), b: toInput(c.field, c.value[1] as number) };
  }
  if (Array.isArray(c.value)) return { ...base, values: c.value as string[] };
  if (typeof c.value === "number") return { ...base, a: toInput(c.field, c.value) };
  if (typeof c.value === "string") return { ...base, a: c.value };
  return base;
}

function toCondition(r: Row): unknown {
  const def = fieldDef(r.field);
  switch (r.op) {
    case "above_field":
      return { field: r.field, op: "gt", ref: r.ref };
    case "below_field":
      return { field: r.field, op: "lt", ref: r.ref };
    case "is_null":
    case "not_null":
      return { field: r.field, op: r.op };
    case "between":
      return {
        field: r.field,
        op: "between",
        value: [fromInput(r.field, r.a), fromInput(r.field, r.b)],
      };
    case "in":
      return { field: r.field, op: "in", value: r.values };
    default:
      return {
        field: r.field,
        op: r.op,
        value:
          def.type === "number" ? (r.a.trim() === "" ? Number.NaN : fromInput(r.field, r.a)) : r.a,
      };
  }
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const GROUPS = ["Descriptive", "Performance", "Technical", "Valuation"] as const;

function FieldSelect(props: {
  value: FieldId;
  onChange: (f: FieldId) => void;
  label: string;
  numericOnly?: boolean;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as FieldId)}
      className="min-h-9 rounded-md border bg-background px-2 text-sm"
    >
      {GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {FIELD_IDS.filter(
            (f) => fieldDef(f).group === g && (!props.numericOnly || fieldDef(f).type === "number"),
          ).map((f) => (
            <option key={f} value={f}>
              {fieldDef(f).label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function ScreenBuilder({ initial }: { initial: Screen }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => initial.conditions.map(toRow));
  const [sort, setSort] = useState(initial.sort);
  const [errors, setErrors] = useState<string[]>([]);

  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const build = () => Screen.safeParse({ conditions: rows.map(toCondition), sort });

  const run = () => {
    const parsed = build();
    if (!parsed.success) {
      setErrors(
        parsed.error.issues.map((i) => {
          const row = typeof i.path[1] === "number" ? `Condition ${i.path[1] + 1}: ` : "";
          return `${row}${i.message}`;
        }),
      );
      return;
    }
    setErrors([]);
    router.push(`/screener?s=${toBase64Url(JSON.stringify(parsed.data))}`);
  };

  const parsed = build();

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Conditions (all must hold)">
        {rows.map((r, i) => {
          const def = fieldDef(r.field);
          const ops =
            def.type === "number" ? NUMBER_OPS : def.type === "enum" ? ENUM_OPS : TEXT_OPS;
          const scale = inputScale(r.field);
          const numberInput = (value: string, onChange: (v: string) => void, label: string) => (
            <span className="flex items-center gap-1">
              <Input
                type="number"
                step="any"
                aria-label={label}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-28"
              />
              {scale.unit ? (
                <span className="text-xs text-muted-foreground">{scale.unit}</span>
              ) : null}
            </span>
          );
          return (
            <li key={r.key} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <FieldSelect
                label={`Condition ${i + 1} field`}
                value={r.field}
                onChange={(field) =>
                  update(r.key, {
                    field,
                    op:
                      fieldDef(field).type === "number"
                        ? "gt"
                        : fieldDef(field).type === "enum"
                          ? "in"
                          : "eq",
                    a: "",
                    b: "",
                    values: [],
                  })
                }
              />
              <select
                aria-label={`Condition ${i + 1} operator`}
                value={r.op}
                onChange={(e) => update(r.key, { op: e.target.value as OpChoice })}
                className="min-h-9 rounded-md border bg-background px-2 text-sm"
              >
                {ops.map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </select>
              {r.op === "above_field" || r.op === "below_field" ? (
                <FieldSelect
                  label={`Condition ${i + 1} compared field`}
                  value={r.ref}
                  numericOnly
                  onChange={(ref) => update(r.key, { ref })}
                />
              ) : r.op === "between" ? (
                <>
                  {numberInput(r.a, (a) => update(r.key, { a }), `Condition ${i + 1} low`)}
                  <span className="text-sm text-muted-foreground">and</span>
                  {numberInput(r.b, (b) => update(r.key, { b }), `Condition ${i + 1} high`)}
                </>
              ) : r.op === "in" ? (
                <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
                  <legend className="sr-only">Condition {i + 1} values</legend>
                  {(def.values ?? []).map((v) => (
                    <label key={v} className="flex min-h-7 items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={r.values.includes(v)}
                        onChange={(e) =>
                          update(r.key, {
                            values: e.target.checked
                              ? [...r.values, v]
                              : r.values.filter((x) => x !== v),
                          })
                        }
                      />
                      {v}
                    </label>
                  ))}
                </fieldset>
              ) : r.op === "is_null" || r.op === "not_null" ? null : def.type === "number" ? (
                numberInput(r.a, (a) => update(r.key, { a }), `Condition ${i + 1} value`)
              ) : def.type === "enum" ? (
                <select
                  aria-label={`Condition ${i + 1} value`}
                  value={r.a}
                  onChange={(e) => update(r.key, { a: e.target.value })}
                  className="min-h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">Choose…</option>
                  {(def.values ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label={`Condition ${i + 1} value`}
                  value={r.a}
                  onChange={(e) => update(r.key, { a: e.target.value })}
                  className="w-40"
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label={`Remove condition ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              >
                <X aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() =>
            setRows((rs) => [
              ...rs,
              {
                key: nextKey++,
                field: "rsi14",
                op: "lt",
                a: "30",
                b: "",
                ref: "sma200",
                values: [],
              },
            ])
          }
        >
          <Plus aria-hidden />
          Add condition
        </Button>
        <span className="text-sm">Sort by</span>
        <FieldSelect
          label="Sort by"
          value={sort.field}
          onChange={(field) => setSort((s) => ({ ...s, field }))}
        />
        <select
          aria-label="Sort direction"
          value={sort.dir}
          onChange={(e) => setSort((s) => ({ ...s, dir: e.target.value as "asc" | "desc" }))}
          className="min-h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="desc">highest first</option>
          <option value="asc">lowest first</option>
        </select>
        <Button variant="primary" onClick={run}>
          Run screen
        </Button>
      </div>

      {errors.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-down">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      <input
        type="hidden"
        name="screen"
        form="save-screen"
        value={parsed.success ? JSON.stringify(parsed.data) : ""}
      />
    </div>
  );
}
