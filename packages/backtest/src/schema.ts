import { z } from "zod";

/**
 * Strategy JSON (Phase 2 step B1; spec §5.15). A strategy is a set of rules over operands
 * (prices, volume, indicators from @market/indicators, point-in-time fundamentals, constants),
 * plus exits, sizing, costs and the test period. Numbers may be `{ "$param": "name" }`
 * placeholders, filled in for a run or varied in a parameter sweep.
 */

export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  integer: boolean;
}

const int = (d: number, min: number, max: number): ParamSpec => ({
  default: d,
  min,
  max,
  integer: true,
});
const real = (d: number, min: number, max: number): ParamSpec => ({
  default: d,
  min,
  max,
  integer: false,
});

/**
 * Units decide how a value is put back into the terms of its own date (see engine): prices and
 * price-based indicators scale with splits and dividends, volume with splits, and ratios not at
 * all.
 */
export type OperandUnit = "price" | "volume" | "ratio";

export interface IndicatorSpec {
  label: string;
  params: Record<string, ParamSpec>;
  outputs: readonly string[];
  unit: OperandUnit;
}

export const INDICATORS = {
  sma: { label: "SMA", params: { period: int(20, 2, 400) }, outputs: ["value"], unit: "price" },
  ema: { label: "EMA", params: { period: int(20, 2, 400) }, outputs: ["value"], unit: "price" },
  wma: { label: "WMA", params: { period: int(20, 2, 400) }, outputs: ["value"], unit: "price" },
  rsi: { label: "RSI", params: { period: int(14, 2, 200) }, outputs: ["value"], unit: "ratio" },
  macd: {
    label: "MACD",
    params: { fast: int(12, 2, 100), slow: int(26, 3, 200), signal: int(9, 2, 100) },
    outputs: ["macd", "signal", "histogram"],
    unit: "price",
  },
  bollinger: {
    label: "Bollinger",
    params: { period: int(20, 2, 400), k: real(2, 0.5, 5) },
    outputs: ["upper", "middle", "lower"],
    unit: "price",
  },
  atr: { label: "ATR", params: { period: int(14, 2, 200) }, outputs: ["value"], unit: "price" },
  stochastic: {
    label: "Stochastic",
    params: { kPeriod: int(14, 2, 200), kSmoothing: int(3, 1, 50), dPeriod: int(3, 1, 50) },
    outputs: ["k", "d"],
    unit: "ratio",
  },
  williams_r: {
    label: "Williams %R",
    params: { period: int(14, 2, 200) },
    outputs: ["value"],
    unit: "ratio",
  },
  cci: { label: "CCI", params: { period: int(20, 2, 200) }, outputs: ["value"], unit: "ratio" },
  adx: {
    label: "ADX",
    params: { period: int(14, 2, 100) },
    outputs: ["adx", "plus_di", "minus_di"],
    unit: "ratio",
  },
  obv: { label: "OBV", params: {}, outputs: ["value"], unit: "volume" },
  volatility: {
    label: "Volatility (annualized)",
    params: { period: int(20, 2, 400) },
    outputs: ["value"],
    unit: "ratio",
  },
  donchian: {
    label: "Donchian",
    params: { period: int(20, 2, 400) },
    outputs: ["upper", "middle", "lower"],
    unit: "price",
  },
  keltner: {
    label: "Keltner",
    params: { period: int(20, 2, 400), multiplier: real(2, 0.5, 5), atrPeriod: int(10, 2, 200) },
    outputs: ["upper", "middle", "lower"],
    unit: "price",
  },
  vwap: { label: "VWAP", params: { period: int(20, 2, 400) }, outputs: ["value"], unit: "price" },
} as const satisfies Record<string, IndicatorSpec>;

export type IndicatorId = keyof typeof INDICATORS;
export const INDICATOR_IDS = Object.keys(INDICATORS) as [IndicatorId, ...IndicatorId[]];

/** Point-in-time fundamentals: only figures filed before the date are used. */
export const FUNDAMENTALS = {
  pe_ttm: { label: "P/E (TTM)" },
  ps_ttm: { label: "P/S (TTM)" },
  market_cap: { label: "Market cap" },
  revenue_growth_yoy: { label: "Revenue growth (TTM, year over year)" },
  net_margin_ttm: { label: "Net margin (TTM)" },
} as const;
export type FundamentalMetric = keyof typeof FUNDAMENTALS;
const FUNDAMENTAL_IDS = Object.keys(FUNDAMENTALS) as [FundamentalMetric, ...FundamentalMetric[]];

export const ParamName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,30}$/, "parameter names are lowercase");
export const ParamRef = z.strictObject({ $param: ParamName });
export type ParamRef = z.infer<typeof ParamRef>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a real date");

const OPS = [">", ">=", "<", "<=", "crosses_above", "crosses_below"] as const;
export type ComparisonOp = (typeof OPS)[number];

/** Builds the schema twice: once allowing `$param` placeholders, once with plain numbers only. */
function schemas<N extends z.ZodType>(num: N) {
  // Costs default to zero. At run time `num` still accepts placeholders; the cast only keeps
  // TypeScript from having to prove that 0 fits the generic output type.
  const cost = (num as unknown as z.ZodNumber).default(0);
  const barsAgo = z
    .number()
    .int()
    .min(0, "look-ahead is not allowed: bars ago must be 0 or more")
    .max(500)
    .default(0);

  const Operand = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("price"),
      field: z.enum(["open", "high", "low", "close"]),
      barsAgo,
    }),
    z.strictObject({ kind: z.literal("volume"), barsAgo }),
    z.strictObject({
      kind: z.literal("indicator"),
      id: z.enum(INDICATOR_IDS),
      params: z.record(z.string(), num).default({}),
      output: z.string().default("value"),
      barsAgo,
    }),
    z.strictObject({ kind: z.literal("fundamental"), metric: z.enum(FUNDAMENTAL_IDS) }),
    z.strictObject({ kind: z.literal("const"), value: num }),
  ]);

  const Comparison = z.strictObject({ left: Operand, op: z.enum(OPS), right: Operand });

  // Groups nest at most three levels deep.
  const Group3 = z.strictObject({
    combine: z.enum(["all", "any"]),
    rules: z.array(Comparison).min(1).max(20),
  });
  const Group2 = z.strictObject({
    combine: z.enum(["all", "any"]),
    rules: z
      .array(z.union([Comparison, Group3]))
      .min(1)
      .max(20),
  });
  const Group = z.strictObject({
    combine: z.enum(["all", "any"]),
    rules: z
      .array(z.union([Comparison, Group2]))
      .min(1)
      .max(20),
  });

  const Strategy = z.strictObject({
    version: z.literal(1),
    universe: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("tickers"),
        tickers: z
          .array(
            z
              .string()
              .trim()
              .toUpperCase()
              .regex(/^[A-Z0-9._-]{1,15}$/, "not a ticker"),
          )
          .min(1)
          .max(200),
      }),
      z.strictObject({ kind: z.literal("all"), assetClass: z.enum(["equity", "etf", "any"]) }),
    ]),
    entry: Group,
    exit: Group.nullable().default(null),
    stops: z
      .strictObject({
        stopLossPct: num.nullable().default(null),
        takeProfitPct: num.nullable().default(null),
        maxHoldingDays: num.nullable().default(null),
      })
      .default({ stopLossPct: null, takeProfitPct: null, maxHoldingDays: null }),
    sizing: z.strictObject({ maxPositions: num }),
    rank: z
      .strictObject({ by: Operand, order: z.enum(["asc", "desc"]) })
      .nullable()
      .default(null),
    rebalance: z.enum(["none", "weekly", "monthly", "quarterly"]).default("none"),
    costs: z
      .strictObject({ commissionPerTrade: cost, commissionBps: cost, slippageBps: cost })
      .default({ commissionPerTrade: 0, commissionBps: 0, slippageBps: 0 }),
    dividends: z.enum(["reinvest", "cash"]).default("reinvest"),
    fractionalShares: z.boolean().default(false),
    initialCapital: num,
    start: isoDate,
    end: isoDate,
    benchmark: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9._-]{1,15}$/)
      .nullable()
      .default(null),
  });
  return { Operand, Comparison, Group, Strategy };
}

const resolved = schemas(z.number().finite());
const withRefs = schemas(z.union([z.number().finite(), ParamRef]));

/** A strategy as stored and edited: numbers may be `$param` placeholders. */
export const StrategyInput = withRefs.Strategy;
export type StrategyInput = z.input<typeof StrategyInput>;

export const Operand = resolved.Operand;
export type Operand = z.infer<typeof Operand>;
export type Comparison = z.infer<typeof resolved.Comparison>;
export type Group = z.infer<typeof resolved.Group>;
export type Rule = Comparison | Group;
export type Strategy = z.infer<typeof resolved.Strategy>;

/** A strategy with every placeholder filled in and every bound checked. */
export const Strategy = resolved.Strategy.superRefine((s, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if (s.start >= s.end) issue(["end"], "the end date must be after the start date");
  if (s.start < "2000-01-01") issue(["start"], "the market calendar starts in 2000");
  if (s.end > "2030-12-31") issue(["end"], "the market calendar ends in 2030");
  if (!(s.initialCapital >= 1 && s.initialCapital <= 1e9)) {
    issue(["initialCapital"], "initial capital must be between 1 and 1,000,000,000");
  }
  const mp = s.sizing.maxPositions;
  if (!Number.isInteger(mp) || mp < 1 || mp > 200) {
    issue(["sizing", "maxPositions"], "max positions must be a whole number from 1 to 200");
  }
  const pct = (v: number | null, path: string[], max: number) => {
    if (v !== null && !(v > 0 && v <= max)) issue(path, `must be above 0 and at most ${max}`);
  };
  pct(s.stops.stopLossPct, ["stops", "stopLossPct"], 0.99);
  pct(s.stops.takeProfitPct, ["stops", "takeProfitPct"], 100);
  const hold = s.stops.maxHoldingDays;
  if (hold !== null && (!Number.isInteger(hold) || hold < 1 || hold > 5000)) {
    issue(["stops", "maxHoldingDays"], "must be a whole number of sessions from 1 to 5000");
  }
  const cost = (v: number, path: string[], max: number) => {
    if (!(v >= 0 && v <= max)) issue(path, `must be from 0 to ${max}`);
  };
  cost(s.costs.commissionPerTrade, ["costs", "commissionPerTrade"], 1000);
  cost(s.costs.commissionBps, ["costs", "commissionBps"], 1000);
  cost(s.costs.slippageBps, ["costs", "slippageBps"], 1000);

  const checkOperand = (o: Operand, path: (string | number)[]) => {
    if (o.kind !== "indicator") return;
    const spec: IndicatorSpec = INDICATORS[o.id];
    if (!spec.outputs.includes(o.output)) {
      issue([...path, "output"], `${spec.label} has outputs ${spec.outputs.join(", ")}`);
    }
    for (const key of Object.keys(o.params)) {
      if (!(key in spec.params)) issue([...path, "params", key], `${spec.label} has no ${key}`);
    }
    for (const [key, p] of Object.entries(spec.params)) {
      const v = o.params[key] ?? p.default;
      if (!(v >= p.min && v <= p.max) || (p.integer && !Number.isInteger(v))) {
        issue(
          [...path, "params", key],
          `${spec.label} ${key} must be ${p.integer ? "a whole number " : ""}from ${p.min} to ${p.max}`,
        );
      }
    }
    if (o.id === "macd") {
      const fast = o.params.fast ?? INDICATORS.macd.params.fast.default;
      const slow = o.params.slow ?? INDICATORS.macd.params.slow.default;
      if (fast >= slow) issue([...path, "params", "fast"], "MACD fast must be below slow");
    }
  };
  const walk = (g: Group | Comparison, path: (string | number)[]) => {
    if ("combine" in g) g.rules.forEach((r, i) => walk(r, [...path, "rules", i]));
    else {
      checkOperand(g.left, [...path, "left"]);
      checkOperand(g.right, [...path, "right"]);
    }
  };
  walk(s.entry, ["entry"]);
  if (s.exit) walk(s.exit, ["exit"]);
  if (s.rank) checkOperand(s.rank.by, ["rank", "by"]);
});

/** Every `$param` name used in a strategy, sorted. */
export function paramNames(input: unknown): string[] {
  const names = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const ref = ParamRef.safeParse(v);
      if (ref.success) names.add(ref.data.$param);
      else Object.values(v).forEach(visit);
    }
  };
  visit(input);
  return [...names].sort();
}

/** Replaces `$param` placeholders with values; throws when one has no value. */
export function fillParams(input: unknown, values: Readonly<Record<string, number>>): unknown {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const ref = ParamRef.safeParse(v);
      if (ref.success) {
        const value = values[ref.data.$param];
        if (value === undefined || !Number.isFinite(value)) {
          throw new Error(`no value for parameter "${ref.data.$param}"`);
        }
        return value;
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    }
    return v;
  };
  return visit(input);
}

/** Validates a strategy with its parameters filled in. */
export function resolveStrategy(
  input: unknown,
  values: Readonly<Record<string, number>> = {},
): Strategy {
  return Strategy.parse(fillParams(StrategyInput.parse(input), values));
}

// --- Words, for the assumptions panel and the builder --------------------------------------

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));

export function describeOperand(o: Operand): string {
  const ago = (k: number) => (k === 0 ? "" : k === 1 ? " (1 bar ago)" : ` (${k} bars ago)`);
  switch (o.kind) {
    case "price":
      return `${o.field[0]!.toUpperCase()}${o.field.slice(1)}${ago(o.barsAgo)}`;
    case "volume":
      return `Volume${ago(o.barsAgo)}`;
    case "const":
      return fmt(o.value);
    case "fundamental":
      return FUNDAMENTALS[o.metric].label;
    case "indicator": {
      const spec: IndicatorSpec = INDICATORS[o.id];
      const args = Object.entries(spec.params).map(([k, p]) => fmt(o.params[k] ?? p.default));
      const output = spec.outputs.length > 1 ? ` ${o.output.replace("_", " ")}` : "";
      return `${spec.label}${args.length ? `(${args.join(", ")})` : ""}${output}${ago(o.barsAgo)}`;
    }
  }
}

const OP_WORDS: Record<ComparisonOp, string> = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

export function describeRule(r: Rule): string {
  if ("combine" in r) {
    const inner = r.rules.map((x) => describeRule(x as Rule));
    return inner.length === 1
      ? inner[0]!
      : `(${inner.join(r.combine === "all" ? " and " : " or ")})`;
  }
  return `${describeOperand(r.left)} ${OP_WORDS[r.op]} ${describeOperand(r.right)}`;
}

/** A readable message for a strategy that failed to parse, resolve or run. */
export function describeError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
