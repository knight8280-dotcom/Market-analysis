import { z } from "zod";
import { ParamName, paramNames, resolveStrategy, type Strategy } from "./schema";

/**
 * What the owner asks the worker to run (Phase 2 steps B6 to B8): one backtest, a parameter
 * sweep, or a walk-forward analysis. Stored as submitted in public.backtest_runs.request; the
 * web checks it before queueing and the worker checks it again before running. Browser-safe.
 */

export const OBJECTIVES = ["cagr", "sharpe", "calmar", "total_return"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const OBJECTIVE_LABELS: Record<Objective, string> = {
  cagr: "CAGR",
  sharpe: "Sharpe ratio",
  calmar: "Calmar ratio",
  total_return: "Total return",
};

/** More combinations than this and the best result is likely overstated: say so. */
export const OVERFIT_WARNING_AT = 20;
export const MAX_COMBINATIONS = 400;
/** Backtests in one walk-forward analysis (combinations × windows). */
export const MAX_RUNS = 2000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const Values = z.record(
  ParamName,
  z.array(z.number().refine(Number.isFinite, "not a number")).min(1).max(50),
);

export const RunRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("single"),
    strategy: z.unknown(),
    /** Optional date splitting the run into in-sample and out-of-sample parts. */
    split: isoDate.nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal("sweep"),
    strategy: z.unknown(),
    params: Values,
    objective: z.enum(OBJECTIVES),
  }),
  z.strictObject({
    kind: z.literal("walk_forward"),
    strategy: z.unknown(),
    params: Values,
    objective: z.enum(OBJECTIVES),
    trainMonths: z.number().int().min(3).max(120),
    testMonths: z.number().int().min(1).max(60),
  }),
]);
export type RunRequest = z.infer<typeof RunRequest>;
export type RunKind = RunRequest["kind"];

/** Every combination of the listed values, in a fixed order (parameter names sorted). */
export function combinations(
  params: Readonly<Record<string, readonly number[]>>,
): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const name of Object.keys(params).sort()) {
    const values = params[name]!;
    if (values.length === 0) throw new Error(`no values listed for "${name}"`);
    out = out.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
  }
  return out;
}

export function overfitWarning(count: number): string | null {
  return count > OVERFIT_WARNING_AT
    ? `${count} parameter combinations were tested. The best of many tries usually looks better than it will do on new data; check it out of sample.`
    : null;
}

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}
const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export interface WindowDates {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
}

/**
 * Walk-forward windows: train on `trainMonths`, test on the following `testMonths`, then roll
 * forward by `testMonths`, so the test windows follow one another without gaps or overlaps.
 */
export function walkForwardWindows(
  start: string,
  end: string,
  trainMonths: number,
  testMonths: number,
): WindowDates[] {
  const out: WindowDates[] = [];
  for (let trainStart = start; ; trainStart = addMonths(trainStart, testMonths)) {
    const testStart = addMonths(trainStart, trainMonths);
    if (testStart > end) break;
    const testEnd = [dayBefore(addMonths(testStart, testMonths)), end].sort()[0]!;
    out.push({ trainStart, trainEnd: dayBefore(testStart), testStart, testEnd });
  }
  return out;
}

export interface CheckedRequest {
  request: RunRequest;
  /** The strategy as it runs (single), or with each parameter at its first value. */
  strategy: Strategy;
  /** Every combination that will run (one empty combination for a single run). */
  combinations: Record<string, number>[];
  windows: WindowDates[];
}

/**
 * Everything that can be checked before running: the request's shape, the strategy, that every
 * parameter has values and every listed value is used, and the size limits. Throws ZodError or
 * Error with a message for the owner.
 */
export function checkRunRequest(input: unknown): CheckedRequest {
  const request = RunRequest.parse(input);
  if (request.kind === "single") {
    const names = paramNames(request.strategy);
    if (names.length) {
      throw new Error(
        `a single run needs numbers, not parameters (${names.join(", ")}); use a sweep or walk-forward to try values`,
      );
    }
    const strategy = resolveStrategy(request.strategy);
    if (
      request.split !== null &&
      !(request.split > strategy.start && request.split <= strategy.end)
    ) {
      throw new Error("the split date must be after the start and no later than the end");
    }
    return { request, strategy, combinations: [{}], windows: [] };
  }

  const names = paramNames(request.strategy);
  if (names.length === 0) {
    throw new Error(
      'the strategy has no parameters to vary; put { "$param": "name" } where a number goes',
    );
  }
  const missing = names.filter((n) => !(n in request.params));
  if (missing.length) throw new Error(`no values for parameter ${missing.join(", ")}`);
  const unused = Object.keys(request.params).filter((n) => !names.includes(n));
  if (unused.length) throw new Error(`parameter ${unused.join(", ")} is not used in the strategy`);
  const combos = combinations(request.params);
  if (combos.length > MAX_COMBINATIONS) {
    throw new Error(
      `${combos.length} combinations is more than the ${MAX_COMBINATIONS} allowed in one run`,
    );
  }
  const strategy = resolveStrategy(request.strategy, combos[0]);

  if (request.kind === "sweep") return { request, strategy, combinations: combos, windows: [] };

  const windows = walkForwardWindows(
    strategy.start,
    strategy.end,
    request.trainMonths,
    request.testMonths,
  );
  if (windows.length === 0) {
    throw new Error("the period is too short for one training window and one test window");
  }
  if (combos.length * windows.length > MAX_RUNS) {
    throw new Error(
      `${combos.length} combinations × ${windows.length} windows is ${combos.length * windows.length} backtests, more than the ${MAX_RUNS} allowed`,
    );
  }
  return { request, strategy, combinations: combos, windows };
}
