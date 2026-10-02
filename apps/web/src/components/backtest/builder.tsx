"use client";

import {
  checkRunRequest,
  OBJECTIVE_LABELS,
  OBJECTIVES,
  overfitWarning,
  type Objective,
} from "@market/backtest/request";
import {
  describeRule,
  FUNDAMENTALS,
  INDICATOR_IDS,
  INDICATORS,
  paramNames,
  type ComparisonOp,
  type FundamentalMetric,
  type IndicatorId,
  type IndicatorSpec,
} from "@market/backtest/schema";
import { Button, cn, Input } from "@market/ui";
import { Plus, X } from "lucide-react";
import { useActionState, useId, useMemo, useState } from "react";

/**
 * Strategy builder (Phase 2 step B8). The form covers one group of entry rules and one of exit
 * rules over prices, volume, indicators, fundamentals and numbers; the JSON view edits the
 * whole request, nested groups included. A number field accepts `$name` to make it a parameter
 * for a sweep or walk-forward. Everything is checked here with the same code the server and the
 * worker use, before anything is queued.
 */

type Num = string;
type PriceField = "open" | "high" | "low" | "close";
type OperandForm =
  | { kind: "price"; field: PriceField; barsAgo: Num }
  | { kind: "volume"; barsAgo: Num }
  | {
      kind: "indicator";
      id: IndicatorId;
      params: Record<string, Num>;
      output: string;
      barsAgo: Num;
    }
  | { kind: "fundamental"; metric: FundamentalMetric }
  | { kind: "const"; value: Num };
interface RuleForm {
  key: number;
  left: OperandForm;
  op: ComparisonOp;
  right: OperandForm;
}
interface GroupForm {
  combine: "all" | "any";
  rules: RuleForm[];
}
type RunKind = "single" | "sweep" | "walk_forward";
export interface FormState {
  universeKind: "tickers" | "equity" | "etf" | "any";
  tickers: string;
  start: string;
  end: string;
  entry: GroupForm;
  exit: GroupForm;
  stopLossPct: Num;
  takeProfitPct: Num;
  maxHoldingDays: Num;
  maxPositions: Num;
  rankOn: boolean;
  rankBy: OperandForm;
  rankOrder: "asc" | "desc";
  rebalance: "none" | "weekly" | "monthly" | "quarterly";
  commissionPerTrade: Num;
  commissionBps: Num;
  slippageBps: Num;
  dividends: "reinvest" | "cash";
  fractionalShares: boolean;
  initialCapital: Num;
  benchmark: string;
  runKind: RunKind;
  split: string;
  objective: Objective;
  values: Record<string, string>;
  trainMonths: Num;
  testMonths: Num;
}

const OPS: { value: ComparisonOp; label: string }[] = [
  { value: ">", label: "is above" },
  { value: ">=", label: "is at or above" },
  { value: "<", label: "is below" },
  { value: "<=", label: "is at or below" },
  { value: "crosses_above", label: "crosses above" },
  { value: "crosses_below", label: "crosses below" },
];
const FUNDAMENTAL_IDS = Object.keys(FUNDAMENTALS) as FundamentalMetric[];
const PARAM = /^\$([a-z][a-z0-9_]{0,30})$/;

let nextKey = 1;
const key = () => nextKey++;

// --- Conversions between the form and the request JSON --------------------------------------

function num(s: Num): unknown {
  const t = s.trim();
  if (t === "") return undefined;
  const m = PARAM.exec(t);
  if (m) return { $param: m[1]! };
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}
function show(v: unknown): Num {
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (v && typeof v === "object" && "$param" in v && typeof v.$param === "string") {
    return `$${v.$param}`;
  }
  return "";
}
const pctIn = (s: Num) => {
  const v = num(s);
  return typeof v === "number" ? v / 100 : (v ?? null);
};
const pctOut = (v: unknown) =>
  typeof v === "number" ? String(Number((v * 100).toFixed(6))) : show(v);

function toOperand(o: OperandForm): unknown {
  switch (o.kind) {
    case "price":
      return { kind: "price", field: o.field, barsAgo: num(o.barsAgo) ?? 0 };
    case "volume":
      return { kind: "volume", barsAgo: num(o.barsAgo) ?? 0 };
    case "indicator":
      return {
        kind: "indicator",
        id: o.id,
        params: Object.fromEntries(
          Object.entries(o.params)
            .map(([k, v]) => [k, num(v)] as const)
            .filter(([, v]) => v !== undefined),
        ),
        output: o.output,
        barsAgo: num(o.barsAgo) ?? 0,
      };
    case "fundamental":
      return { kind: "fundamental", metric: o.metric };
    case "const":
      return { kind: "const", value: num(o.value) };
  }
}

function indicatorForm(
  id: IndicatorId,
  params: Record<string, unknown> = {},
  output?: string,
): OperandForm {
  const spec: IndicatorSpec = INDICATORS[id];
  return {
    kind: "indicator",
    id,
    params: Object.fromEntries(Object.keys(spec.params).map((k) => [k, show(params[k])])),
    output: output && spec.outputs.includes(output) ? output : spec.outputs[0]!,
    barsAgo: "",
  };
}

function fromOperand(raw: unknown): OperandForm {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ago = o.barsAgo === undefined || o.barsAgo === 0 ? "" : show(o.barsAgo);
  switch (o.kind) {
    case "price":
      return { kind: "price", field: (o.field as PriceField) ?? "close", barsAgo: ago };
    case "volume":
      return { kind: "volume", barsAgo: ago };
    case "indicator": {
      const id = (INDICATOR_IDS as readonly string[]).includes(o.id as string)
        ? (o.id as IndicatorId)
        : "sma";
      const f = indicatorForm(id, (o.params as Record<string, unknown>) ?? {}, o.output as string);
      return { ...f, barsAgo: ago } as OperandForm;
    }
    case "fundamental":
      return { kind: "fundamental", metric: (o.metric as FundamentalMetric) ?? "pe_ttm" };
    default:
      return { kind: "const", value: show(o.value) };
  }
}

function fromGroup(raw: unknown): GroupForm | null {
  if (raw === null || raw === undefined) return { combine: "all", rules: [] };
  const g = raw as { combine?: "all" | "any"; rules?: unknown[] };
  const rules: RuleForm[] = [];
  for (const r of g.rules ?? []) {
    const c = r as Record<string, unknown>;
    if ("combine" in c) return null; // nested group: JSON only
    rules.push({
      key: key(),
      left: fromOperand(c.left),
      op: c.op as ComparisonOp,
      right: fromOperand(c.right),
    });
  }
  return { combine: g.combine ?? "all", rules };
}

/** Form state from a request (or a bare strategy); null when the form cannot show it. */
export function fromRequest(raw: unknown, fallback: FormState): FormState | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (("strategy" in r ? r.strategy : r) ?? {}) as Record<string, unknown>;
  const entry = fromGroup(s.entry);
  const exit = fromGroup(s.exit);
  if (!entry || !exit) return null;
  const u = (s.universe ?? {}) as { kind?: string; tickers?: string[]; assetClass?: string };
  const stops = (s.stops ?? {}) as Record<string, unknown>;
  const costs = (s.costs ?? {}) as Record<string, unknown>;
  const rank = s.rank as { by: unknown; order: "asc" | "desc" } | null | undefined;
  const params = (r.params ?? {}) as Record<string, number[]>;
  const kind = (r.kind as RunKind | undefined) ?? "single";
  return {
    ...fallback,
    universeKind:
      u.kind === "tickers" ? "tickers" : ((u.assetClass as FormState["universeKind"]) ?? "equity"),
    tickers: (u.tickers ?? []).join(", "),
    start: (s.start as string) ?? fallback.start,
    end: (s.end as string) ?? fallback.end,
    entry,
    exit,
    stopLossPct: pctOut(stops.stopLossPct),
    takeProfitPct: pctOut(stops.takeProfitPct),
    maxHoldingDays: show(stops.maxHoldingDays),
    maxPositions: show((s.sizing as Record<string, unknown> | undefined)?.maxPositions),
    rankOn: !!rank,
    rankBy: rank ? fromOperand(rank.by) : fallback.rankBy,
    rankOrder: rank?.order ?? "desc",
    rebalance: (s.rebalance as FormState["rebalance"]) ?? "none",
    commissionPerTrade: show(costs.commissionPerTrade ?? 0),
    commissionBps: show(costs.commissionBps ?? 0),
    slippageBps: show(costs.slippageBps ?? 0),
    dividends: (s.dividends as FormState["dividends"]) ?? "reinvest",
    fractionalShares: (s.fractionalShares as boolean) ?? false,
    initialCapital: show(s.initialCapital),
    benchmark: (s.benchmark as string) ?? "",
    runKind: kind,
    split: (r.split as string) ?? "",
    objective: (r.objective as Objective) ?? "sharpe",
    values: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.join(", ")])),
    trainMonths: show(r.trainMonths ?? fallback.trainMonths),
    testMonths: show(r.testMonths ?? fallback.testMonths),
  };
}

function strategyOf(f: FormState): Record<string, unknown> {
  const group = (g: GroupForm) => ({
    combine: g.combine,
    rules: g.rules.map((r) => ({ left: toOperand(r.left), op: r.op, right: toOperand(r.right) })),
  });
  return {
    version: 1,
    universe:
      f.universeKind === "tickers"
        ? {
            kind: "tickers",
            tickers: f.tickers
              .split(/[\s,]+/)
              .map((t) => t.trim().toUpperCase())
              .filter(Boolean),
          }
        : { kind: "all", assetClass: f.universeKind },
    entry: group(f.entry),
    exit: f.exit.rules.length ? group(f.exit) : null,
    stops: {
      stopLossPct: pctIn(f.stopLossPct),
      takeProfitPct: pctIn(f.takeProfitPct),
      maxHoldingDays: num(f.maxHoldingDays) ?? null,
    },
    sizing: { maxPositions: num(f.maxPositions) },
    rank: f.rankOn ? { by: toOperand(f.rankBy), order: f.rankOrder } : null,
    rebalance: f.rebalance,
    costs: {
      commissionPerTrade: num(f.commissionPerTrade) ?? 0,
      commissionBps: num(f.commissionBps) ?? 0,
      slippageBps: num(f.slippageBps) ?? 0,
    },
    dividends: f.dividends,
    fractionalShares: f.fractionalShares,
    initialCapital: num(f.initialCapital),
    start: f.start,
    end: f.end,
    benchmark: f.benchmark.trim() ? f.benchmark.trim().toUpperCase() : null,
  };
}

/** "10, 20, 50" or "10:50:10" (start:end:step), or a mix. */
export function parseValues(text: string): number[] | string {
  const out: number[] = [];
  for (const part of text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const range = /^(-?[\d.]+)\s*:\s*(-?[\d.]+)\s*:\s*([\d.]+)$/.exec(part);
    if (range) {
      const [a, b, step] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (!(step > 0) || b < a) return `"${part}" is not a range (start:end:step)`;
      for (let x = a, i = 0; x <= b + 1e-9 && i < 1000; i++, x = a + i * step) {
        out.push(Number(x.toFixed(10)));
      }
    } else if (Number.isFinite(Number(part))) {
      out.push(Number(part));
    } else {
      return `"${part}" is not a number`;
    }
  }
  return [...new Set(out)];
}

export function requestOf(f: FormState): unknown {
  const strategy = strategyOf(f);
  if (f.runKind === "single") return { kind: "single", strategy, split: f.split || null };
  const params: Record<string, number[]> = {};
  for (const name of paramNames(strategy)) {
    const v = parseValues(f.values[name] ?? "");
    params[name] = typeof v === "string" ? [] : v;
  }
  const base = { strategy, params, objective: f.objective };
  return f.runKind === "sweep"
    ? { kind: "sweep", ...base }
    : {
        kind: "walk_forward",
        ...base,
        trainMonths: num(f.trainMonths),
        testMonths: num(f.testMonths),
      };
}

const LABELS: Record<string, string> = {
  maxPositions: "Max positions",
  stopLossPct: "Stop loss",
  takeProfitPct: "Take profit",
  maxHoldingDays: "Holding limit",
  initialCapital: "Starting capital",
  commissionPerTrade: "Commission per trade",
  commissionBps: "Commission (bps)",
  slippageBps: "Slippage (bps)",
  tickers: "Tickers",
  start: "Start",
  end: "End",
  benchmark: "Benchmark",
  trainMonths: "Training months",
  testMonths: "Test months",
  split: "Split date",
};

/** Messages with friendly locations, from the same checks the worker runs. */
export function problemsOf(request: unknown): string[] {
  try {
    checkRunRequest(request);
    return [];
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (!Array.isArray(issues)) return [err instanceof Error ? err.message : String(err)];
    return issues.map((i) => {
      const path = i.path.filter((p) => p !== "strategy");
      const parts: string[] = [];
      for (let k = 0; k < path.length; k++) {
        const p = path[k];
        if (
          (p === "entry" || p === "exit") &&
          path[k + 1] === "rules" &&
          typeof path[k + 2] === "number"
        ) {
          parts.push(`${p === "entry" ? "Entry" : "Exit"} rule ${(path[k + 2] as number) + 1}`);
          k += 2;
        } else if (p === "left" || p === "right") parts.push(`${p} side`);
        else if (
          p === "stops" ||
          p === "sizing" ||
          p === "costs" ||
          p === "params" ||
          p === "universe"
        )
          continue;
        else if (typeof p === "string") parts.push(LABELS[p] ?? p);
      }
      return parts.length ? `${parts.join(", ")}: ${i.message}` : i.message;
    });
  }
}

// --- Components ------------------------------------------------------------------------------

const selectClass =
  "min-h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(selectClass, className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SmallInput({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn("w-20", className)}
      inputMode="text"
      autoComplete="off"
    />
  );
}

const KINDS: { value: OperandForm["kind"]; label: string }[] = [
  { value: "price", label: "Price" },
  { value: "indicator", label: "Indicator" },
  { value: "volume", label: "Volume" },
  { value: "fundamental", label: "Fundamental" },
  { value: "const", label: "Number" },
];

function blank(kind: OperandForm["kind"]): OperandForm {
  switch (kind) {
    case "price":
      return { kind, field: "close", barsAgo: "" };
    case "volume":
      return { kind, barsAgo: "" };
    case "indicator":
      return indicatorForm("sma");
    case "fundamental":
      return { kind, metric: "pe_ttm" };
    case "const":
      return { kind, value: "0" };
  }
}

function OperandEditor({
  value,
  onChange,
  label,
}: {
  value: OperandForm;
  onChange: (o: OperandForm) => void;
  label: string;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Select
        label={`${label}: kind`}
        value={value.kind}
        onChange={(k) => onChange(blank(k))}
        options={KINDS}
      />
      {value.kind === "price" ? (
        <Select
          label={`${label}: price`}
          value={value.field}
          onChange={(field) => onChange({ ...value, field })}
          options={[
            { value: "close", label: "Close" },
            { value: "open", label: "Open" },
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ]}
        />
      ) : null}
      {value.kind === "indicator" ? (
        <>
          <Select
            label={`${label}: indicator`}
            value={value.id}
            onChange={(id) => onChange(indicatorForm(id))}
            options={INDICATOR_IDS.map((id) => ({ value: id, label: INDICATORS[id].label }))}
          />
          {Object.entries((INDICATORS[value.id] as IndicatorSpec).params).map(([k, p]) => (
            <SmallInput
              key={k}
              label={`${label}: ${k}`}
              value={value.params[k] ?? ""}
              placeholder={`${k} ${p.default}`}
              onChange={(v) => onChange({ ...value, params: { ...value.params, [k]: v } })}
              className="w-24"
            />
          ))}
          {(INDICATORS[value.id] as IndicatorSpec).outputs.length > 1 ? (
            <Select
              label={`${label}: output`}
              value={value.output}
              onChange={(output) => onChange({ ...value, output })}
              options={(INDICATORS[value.id] as IndicatorSpec).outputs.map((o) => ({
                value: o,
                label: o.replace("_", " "),
              }))}
            />
          ) : null}
        </>
      ) : null}
      {value.kind === "fundamental" ? (
        <Select
          label={`${label}: metric`}
          value={value.metric}
          onChange={(metric) => onChange({ ...value, metric })}
          options={FUNDAMENTAL_IDS.map((m) => ({ value: m, label: FUNDAMENTALS[m].label }))}
        />
      ) : null}
      {value.kind === "const" ? (
        <SmallInput
          label={`${label}: number`}
          value={value.value}
          onChange={(v) => onChange({ ...value, value: v })}
          className="w-24"
        />
      ) : null}
      {value.kind === "price" || value.kind === "volume" || value.kind === "indicator" ? (
        <SmallInput
          label={`${label}: bars ago`}
          value={value.barsAgo}
          placeholder="0 ago"
          onChange={(v) => onChange({ ...value, barsAgo: v })}
        />
      ) : null}
    </span>
  );
}

function RulesEditor({
  name,
  group,
  onChange,
  allowEmpty,
}: {
  name: "Entry" | "Exit";
  group: GroupForm;
  onChange: (g: GroupForm) => void;
  allowEmpty: boolean;
}) {
  const update = (k: number, patch: Partial<RuleForm>) =>
    onChange({ ...group, rules: group.rules.map((r) => (r.key === k ? { ...r, ...patch } : r)) });
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">
        {name === "Entry" ? "Enter when" : "Exit when"}
      </legend>
      {group.rules.length > 1 ? (
        <Select
          label={`${name}: combine rules`}
          value={group.combine}
          onChange={(combine) => onChange({ ...group, combine })}
          options={[
            { value: "all", label: "all of these hold" },
            { value: "any", label: "any of these holds" },
          ]}
          className="self-start"
        />
      ) : null}
      {group.rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {name === "Exit"
            ? "No exit rule: positions close only on stops, the holding limit or a delisting."
            : "Add at least one rule."}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {group.rules.map((r, i) => {
          const label = `${name} rule ${i + 1}`;
          return (
            <li
              key={r.key}
              className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 p-2"
            >
              <OperandEditor
                label={`${label}, left`}
                value={r.left}
                onChange={(left) => update(r.key, { left })}
              />
              <Select
                label={`${label}: comparison`}
                value={r.op}
                onChange={(op) => update(r.key, { op })}
                options={OPS}
              />
              <OperandEditor
                label={`${label}, right`}
                value={r.right}
                onChange={(right) => update(r.key, { right })}
              />
              {group.rules.length > 1 || allowEmpty ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${label.toLowerCase()}`}
                  onClick={() =>
                    onChange({ ...group, rules: group.rules.filter((x) => x.key !== r.key) })
                  }
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          onChange({
            ...group,
            rules: [
              ...group.rules,
              { key: key(), left: blank("price"), op: ">", right: indicatorForm("sma") },
            ],
          })
        }
      >
        <Plus aria-hidden /> Add {name.toLowerCase()} rule
      </Button>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  request: unknown;
}

export function BacktestBuilder({
  action,
  initialName,
  initial,
  defaults,
  presets,
  riskFreeStored,
}: {
  action: (prev: { error: string | null }, form: FormData) => Promise<{ error: string | null }>;
  initialName: string;
  initial: unknown;
  defaults: FormState;
  presets: Preset[];
  /** Whether T-bill rates are stored; ranking by Sharpe ratio needs them. */
  riskFreeStored: boolean;
}) {
  const startForm = useMemo(() => fromRequest(initial, defaults), [initial, defaults]);
  const [form, setForm] = useState<FormState>(startForm ?? defaults);
  const [mode, setMode] = useState<"form" | "json">(startForm ? "form" : "json");
  const [json, setJson] = useState(() => JSON.stringify(initial ?? requestOf(defaults), null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const [save, setSave] = useState(true);
  const [showProblems, setShowProblems] = useState(false);
  const [state, formAction, pending] = useActionState(action, { error: null });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  let request: unknown;
  let parseError: string | null = null;
  if (mode === "form") request = requestOf(form);
  else {
    try {
      request = JSON.parse(json) as unknown;
    } catch {
      parseError = "The JSON does not parse.";
    }
  }
  const problems = parseError ? [parseError] : problemsOf(request);
  const strategy =
    request && typeof request === "object"
      ? (request as { strategy?: unknown }).strategy
      : undefined;
  const names = strategy ? paramNames(strategy) : [];
  const runKind =
    mode === "form"
      ? form.runKind
      : ((request as { kind?: RunKind } | undefined)?.kind ?? "single");
  const counts = names.map((n) => {
    const v = parseValues(form.values[n] ?? "");
    return typeof v === "string" ? 0 : v.length;
  });
  const combos = counts.reduce((a, b) => a * b, 1);
  let preview: { entry: string; exit: string | null } | null = null;
  if (problems.length === 0) {
    try {
      const { strategy: s } = checkRunRequest(request);
      preview = { entry: describeRule(s.entry), exit: s.exit ? describeRule(s.exit) : null };
    } catch {
      preview = null;
    }
  }

  const toJson = () => {
    setJson(JSON.stringify(requestOf(form), null, 2));
    setJsonError(null);
    setMode("json");
  };
  const toForm = () => {
    try {
      const parsed = fromRequest(JSON.parse(json) as unknown, defaults);
      if (!parsed) {
        setJsonError("Nested rule groups can only be edited as JSON.");
        return;
      }
      setForm(parsed);
      setJsonError(null);
      setMode("form");
    } catch {
      setJsonError("The JSON does not parse.");
    }
  };
  const loadPreset = (p: Preset) => {
    const parsed = fromRequest(p.request, defaults);
    setName(p.label);
    if (parsed) {
      setForm(parsed);
      setMode("form");
    } else {
      setJson(JSON.stringify(p.request, null, 2));
      setMode("json");
    }
    setShowProblems(false);
  };

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (problems.length) {
          e.preventDefault();
          setShowProblems(true);
        }
      }}
      className="flex flex-col gap-5"
    >
      <input
        type="hidden"
        name="request"
        value={request === undefined ? "" : JSON.stringify(request)}
      />

      <section aria-label="Examples" className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Start from an example (examples of rule types, not suggestions to trade them):
        </p>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => loadPreset(p)}
              title={p.description}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-3">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              className="w-72 max-w-full"
            />
          )}
        </Field>
        <label className="flex min-h-9 items-center gap-2 text-sm sm:mt-5">
          <input
            type="checkbox"
            name="save"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
            className="size-4"
          />
          Save the strategy under this name
        </label>
        <div className="ml-auto flex gap-1" role="group" aria-label="Editor">
          <Button
            type="button"
            size="sm"
            variant={mode === "form" ? "primary" : "ghost"}
            aria-pressed={mode === "form"}
            onClick={toForm}
          >
            Form
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "json" ? "primary" : "ghost"}
            aria-pressed={mode === "json"}
            onClick={toJson}
          >
            JSON
          </Button>
        </div>
      </div>

      {mode === "json" ? (
        <Field
          label="Request (JSON)"
          hint="The whole request: run type, strategy (nested rule groups allowed), parameter values."
        >
          {(id) => (
            <textarea
              id={id}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              rows={24}
              className="w-full rounded-md border bg-background p-3 font-mono text-xs"
            />
          )}
        </Field>
      ) : (
        <>
          <fieldset className="flex flex-wrap items-start gap-3">
            <legend className="mb-2 text-sm font-medium">What and when</legend>
            <Field label="Universe">
              {(id) => (
                <select
                  id={id}
                  value={form.universeKind}
                  onChange={(e) => set("universeKind", e.target.value as FormState["universeKind"])}
                  className={selectClass}
                >
                  <option value="tickers">These tickers</option>
                  <option value="equity">All stored stocks</option>
                  <option value="etf">All stored ETFs</option>
                  <option value="any">All stored stocks and ETFs</option>
                </select>
              )}
            </Field>
            {form.universeKind === "tickers" ? (
              <Field label="Tickers" hint="Comma-separated">
                {(id) => (
                  <Input
                    id={id}
                    value={form.tickers}
                    onChange={(e) => set("tickers", e.target.value)}
                    className="w-72 max-w-full"
                  />
                )}
              </Field>
            ) : null}
            <Field label="Start">
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={form.start}
                  onChange={(e) => set("start", e.target.value)}
                  className="w-40"
                />
              )}
            </Field>
            <Field label="End">
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={form.end}
                  onChange={(e) => set("end", e.target.value)}
                  className="w-40"
                />
              )}
            </Field>
            <Field label="Benchmark" hint="Ticker, total return">
              {(id) => (
                <Input
                  id={id}
                  value={form.benchmark}
                  onChange={(e) => set("benchmark", e.target.value)}
                  className="w-28"
                />
              )}
            </Field>
          </fieldset>

          <RulesEditor
            name="Entry"
            group={form.entry}
            onChange={(g) => set("entry", g)}
            allowEmpty={false}
          />
          <RulesEditor name="Exit" group={form.exit} onChange={(g) => set("exit", g)} allowEmpty />

          <fieldset className="flex flex-wrap items-start gap-3">
            <legend className="mb-2 text-sm font-medium">Positions and exits</legend>
            <Field label="Max positions" hint="Equal weight">
              {(id) => (
                <Input
                  id={id}
                  value={form.maxPositions}
                  onChange={(e) => set("maxPositions", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Stop loss (%)" hint="Below the entry price">
              {(id) => (
                <Input
                  id={id}
                  value={form.stopLossPct}
                  onChange={(e) => set("stopLossPct", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Take profit (%)" hint="Above the entry price">
              {(id) => (
                <Input
                  id={id}
                  value={form.takeProfitPct}
                  onChange={(e) => set("takeProfitPct", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Holding limit" hint="Sessions">
              {(id) => (
                <Input
                  id={id}
                  value={form.maxHoldingDays}
                  onChange={(e) => set("maxHoldingDays", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Rebalance">
              {(id) => (
                <select
                  id={id}
                  value={form.rebalance}
                  onChange={(e) => set("rebalance", e.target.value as FormState["rebalance"])}
                  className={selectClass}
                >
                  <option value="none">Never</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                </select>
              )}
            </Field>
            <label className="flex min-h-9 items-center gap-2 text-sm sm:mt-5">
              <input
                type="checkbox"
                checked={form.rankOn}
                onChange={(e) => set("rankOn", e.target.checked)}
                className="size-4"
              />
              Rank candidates when there are more than free slots
            </label>
            {form.rankOn ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <OperandEditor
                  label="Rank by"
                  value={form.rankBy}
                  onChange={(o) => set("rankBy", o)}
                />
                <Select
                  label="Rank order"
                  value={form.rankOrder}
                  onChange={(v) => set("rankOrder", v)}
                  options={[
                    { value: "desc", label: "highest first" },
                    { value: "asc", label: "lowest first" },
                  ]}
                />
              </span>
            ) : null}
          </fieldset>

          <fieldset className="flex flex-wrap items-start gap-3">
            <legend className="mb-2 text-sm font-medium">Money and costs</legend>
            <Field label="Starting capital ($)">
              {(id) => (
                <Input
                  id={id}
                  value={form.initialCapital}
                  onChange={(e) => set("initialCapital", e.target.value)}
                  className="w-32"
                />
              )}
            </Field>
            <Field label="Commission per trade ($)">
              {(id) => (
                <Input
                  id={id}
                  value={form.commissionPerTrade}
                  onChange={(e) => set("commissionPerTrade", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Commission (bps)" hint="Of each fill's value">
              {(id) => (
                <Input
                  id={id}
                  value={form.commissionBps}
                  onChange={(e) => set("commissionBps", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Slippage (bps)" hint="Against each fill">
              {(id) => (
                <Input
                  id={id}
                  value={form.slippageBps}
                  onChange={(e) => set("slippageBps", e.target.value)}
                  className="w-24"
                />
              )}
            </Field>
            <Field label="Dividends">
              {(id) => (
                <select
                  id={id}
                  value={form.dividends}
                  onChange={(e) => set("dividends", e.target.value as FormState["dividends"])}
                  className={selectClass}
                >
                  <option value="reinvest">Reinvest</option>
                  <option value="cash">Keep as cash</option>
                </select>
              )}
            </Field>
            <label className="flex min-h-9 items-center gap-2 text-sm sm:mt-5">
              <input
                type="checkbox"
                checked={form.fractionalShares}
                onChange={(e) => set("fractionalShares", e.target.checked)}
                className="size-4"
              />
              Fractional shares
            </label>
          </fieldset>

          <fieldset className="flex flex-wrap items-start gap-3">
            <legend className="mb-2 text-sm font-medium">Run</legend>
            <Field label="Type">
              {(id) => (
                <select
                  id={id}
                  value={form.runKind}
                  onChange={(e) => set("runKind", e.target.value as RunKind)}
                  className={selectClass}
                >
                  <option value="single">Single run</option>
                  <option value="sweep">Parameter sweep</option>
                  <option value="walk_forward">Walk-forward</option>
                </select>
              )}
            </Field>
            {form.runKind === "single" ? (
              <Field
                label="Out-of-sample split (optional)"
                hint="Shows measures before and from this date"
              >
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={form.split}
                    onChange={(e) => set("split", e.target.value)}
                    className="w-40"
                  />
                )}
              </Field>
            ) : (
              <Field label="Choose by">
                {(id) => (
                  <select
                    id={id}
                    value={form.objective}
                    onChange={(e) => set("objective", e.target.value as Objective)}
                    className={selectClass}
                  >
                    {OBJECTIVES.map((o) => (
                      <option key={o} value={o}>
                        {OBJECTIVE_LABELS[o]}
                        {o === "sharpe" && !riskFreeStored
                          ? " (needs T-bill rates, none stored)"
                          : ""}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            {form.runKind === "walk_forward" ? (
              <>
                <Field label="Training months">
                  {(id) => (
                    <Input
                      id={id}
                      value={form.trainMonths}
                      onChange={(e) => set("trainMonths", e.target.value)}
                      className="w-24"
                    />
                  )}
                </Field>
                <Field label="Test months">
                  {(id) => (
                    <Input
                      id={id}
                      value={form.testMonths}
                      onChange={(e) => set("testMonths", e.target.value)}
                      className="w-24"
                    />
                  )}
                </Field>
              </>
            ) : null}
          </fieldset>

          {form.runKind !== "single" ? (
            <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Parameter values</legend>
              {names.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Type <code className="font-mono">$name</code> in a number field (an indicator
                  period, a number, max positions) to make it a parameter, then list its values
                  here.
                </p>
              ) : (
                <>
                  {names.map((n) => (
                    <Field
                      key={n}
                      label={`Values for $${n}`}
                      hint="e.g. 10, 20, 50 or 10:50:10 (start:end:step)"
                    >
                      {(id) => (
                        <Input
                          id={id}
                          value={form.values[n] ?? ""}
                          onChange={(e) => set("values", { ...form.values, [n]: e.target.value })}
                          className="w-72 max-w-full"
                        />
                      )}
                    </Field>
                  ))}
                  <p className="text-sm" aria-live="polite">
                    {combos} combination{combos === 1 ? "" : "s"}
                    {overfitWarning(combos) ? (
                      <span className="mt-1 block text-warning">{overfitWarning(combos)}</span>
                    ) : null}
                  </p>
                </>
              )}
            </fieldset>
          ) : null}
        </>
      )}

      {jsonError ? (
        <p role="alert" className="text-sm text-down">
          {jsonError}
        </p>
      ) : null}

      {preview ? (
        <section aria-label="Rules in words" className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p>
            <span className="text-muted-foreground">Enter when </span>
            {preview.entry}
          </p>
          <p>
            <span className="text-muted-foreground">Exit when </span>
            {preview.exit ?? "a stop, the holding limit or a delisting ends the position"}
          </p>
          {runKind !== "single" ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Parameters are shown at their first values.
            </p>
          ) : null}
        </section>
      ) : null}

      {(showProblems || state.error) && (problems.length || state.error) ? (
        <div role="alert" className="rounded-lg border border-down/60 p-3 text-sm">
          <p className="font-medium text-down">Fix these first:</p>
          <ul className="mt-1 list-disc pl-5">
            {(state.error ? [state.error] : problems).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Queueing…" : runKind === "single" ? "Run backtest" : "Run analysis"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Results are hypothetical and come with their assumptions; nothing is traded.
        </p>
      </div>
    </form>
  );
}
