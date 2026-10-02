import { paramNames } from "@market/backtest/schema";
import { addDays } from "@market/calendar";
import { Card, CardContent, formatDate } from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import {
  BacktestBuilder,
  type FormState,
  type Preset,
} from "../../../../components/backtest/builder";
import { requireOwner } from "../../../../server/auth/owner";
import { getRun, getStrategy } from "../../../../server/backtests";
import { db } from "../../../../server/db";
import { requireFlag } from "../../../../server/flags";
import { lastUpdated, priceSource } from "../../../../server/market";
import { queueBacktest } from "../actions";

export const metadata: Metadata = { title: "New backtest" };

type Search = Promise<Record<string, string | string[] | undefined>>;

const sma = (period: unknown) => ({ kind: "indicator", id: "sma", params: { period } });
const close = { kind: "price", field: "close" };

/** Examples of rule types to start from. Descriptive, not suggestions. */
function presets(
  start: string,
  end: string,
  benchmark: string | null,
  objective: "sharpe" | "cagr",
): Preset[] {
  const base = {
    version: 1,
    universe: { kind: "all", assetClass: "equity" },
    initialCapital: 100_000,
    costs: { commissionPerTrade: 1, commissionBps: 0, slippageBps: 5 },
    fractionalShares: true,
    start,
    end,
    benchmark,
  };
  return [
    {
      id: "trend",
      label: "Trend: 50-day above 200-day average",
      description: "Holds stocks while their 50-session average is above the 200-session one.",
      request: {
        kind: "single",
        split: null,
        strategy: {
          ...base,
          entry: { combine: "all", rules: [{ left: sma(50), op: ">", right: sma(200) }] },
          exit: { combine: "all", rules: [{ left: sma(50), op: "<", right: sma(200) }] },
          sizing: { maxPositions: 10 },
          rank: {
            by: { kind: "indicator", id: "rsi", params: { period: 14 } },
            order: "desc",
          },
          rebalance: "monthly",
        },
      },
    },
    {
      id: "rsi",
      label: "Mean reversion: RSI below 30",
      description:
        "Buys when the 14-session RSI drops below 30 and sells above 50, with a 10% stop.",
      request: {
        kind: "single",
        split: null,
        strategy: {
          ...base,
          entry: {
            combine: "all",
            rules: [
              {
                left: { kind: "indicator", id: "rsi", params: { period: 14 } },
                op: "<",
                right: { kind: "const", value: 30 },
              },
            ],
          },
          exit: {
            combine: "all",
            rules: [
              {
                left: { kind: "indicator", id: "rsi", params: { period: 14 } },
                op: ">",
                right: { kind: "const", value: 50 },
              },
            ],
          },
          stops: { stopLossPct: 0.1 },
          sizing: { maxPositions: 5 },
        },
      },
    },
    ...(benchmark
      ? [
          {
            id: "hold",
            label: `Buy and hold ${benchmark}`,
            description: "Buys once and holds to the end, for comparison with other runs.",
            request: {
              kind: "single",
              split: null,
              strategy: {
                ...base,
                universe: { kind: "tickers", tickers: [benchmark] },
                entry: {
                  combine: "all",
                  rules: [
                    {
                      left: { kind: "const", value: 1 },
                      op: ">",
                      right: { kind: "const", value: 0 },
                    },
                  ],
                },
                exit: null,
                sizing: { maxPositions: 1 },
                costs: { commissionPerTrade: 0, commissionBps: 0, slippageBps: 0 },
              },
            },
          },
        ]
      : []),
    {
      id: "sweep",
      label: "Sweep: price above an n-day average",
      description: "Tries four moving-average lengths and compares them.",
      request: {
        kind: "sweep",
        objective,
        params: { n: [20, 50, 100, 200] },
        strategy: {
          ...base,
          entry: { combine: "all", rules: [{ left: close, op: ">", right: sma({ $param: "n" }) }] },
          exit: { combine: "all", rules: [{ left: close, op: "<", right: sma({ $param: "n" }) }] },
          sizing: { maxPositions: 10 },
        },
      },
    },
  ];
}

/** Builder for a new run, empty or from a saved strategy or an earlier run (Phase 2 step B8). */
export default async function NewBacktestPage({ searchParams }: { searchParams: Search }) {
  await requireOwner();
  await requireFlag("backtests");
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);

  const database = db();
  const source = await priceSource(database);
  const latest = source ? (await lastUpdated(database, source)).session : null;
  const end = latest ?? new Date().toISOString().slice(0, 10);
  const first = source
    ? await database
        .selectFrom("market.prices_daily")
        .select((eb) => eb.fn.min("date").as("date"))
        .where("source", "=", source)
        .executeTakeFirst()
    : undefined;
  const fiveYears = addDays(end, -5 * 365);
  const start = first?.date && first.date > fiveYears ? first.date : fiveYears;
  const spy = await database
    .selectFrom("market.securities")
    .select("ticker")
    .where("ticker", "=", "SPY")
    .executeTakeFirst();
  const etf = spy
    ? undefined
    : await database
        .selectFrom("market.securities")
        .select("ticker")
        .where("asset_class", "=", "etf")
        .where("is_active", "=", true)
        .orderBy("ticker")
        .executeTakeFirst();
  const benchmark = spy?.ticker ?? etf?.ticker ?? null;
  // Ranking by Sharpe ratio needs T-bill rates; without them, rank by CAGR.
  const rates = await database
    .selectFrom("market.macro_observations")
    .select("date")
    .where("series_id", "=", "DTB3")
    .limit(1)
    .executeTakeFirst();
  const objective = rates ? "sharpe" : "cagr";

  const examples = presets(start, end, benchmark, objective);
  const defaults: FormState = {
    universeKind: "equity",
    tickers: "",
    start,
    end,
    entry: { combine: "all", rules: [] },
    exit: { combine: "all", rules: [] },
    stopLossPct: "",
    takeProfitPct: "",
    maxHoldingDays: "",
    maxPositions: "10",
    rankOn: false,
    rankBy: { kind: "indicator", id: "rsi", params: { period: "" }, output: "value", barsAgo: "" },
    rankOrder: "desc",
    rebalance: "none",
    commissionPerTrade: "1",
    commissionBps: "0",
    slippageBps: "5",
    dividends: "reinvest",
    fractionalShares: true,
    initialCapital: "100000",
    benchmark: benchmark ?? "",
    runKind: "single",
    split: "",
    objective,
    values: {},
    trainMonths: "24",
    testMonths: "6",
  };

  let initial: unknown = examples[0]!.request;
  let initialName = examples[0]!.label;
  const strategyId = one("strategy");
  const runId = one("run");
  if (strategyId) {
    const saved = await getStrategy(strategyId);
    if (saved) {
      initialName = saved.name;
      initial = paramNames(saved.definition).length
        ? { kind: "sweep", objective: "sharpe", params: {}, strategy: saved.definition }
        : { kind: "single", split: null, strategy: saved.definition };
    }
  } else if (runId) {
    const run = await getRun(runId);
    if (run) {
      initialName = run.name;
      initial = run.request;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/backtests" className="underline underline-offset-2">
            Backtests
          </Link>{" "}
          / new
        </p>
        <h1 className="mt-1 text-xl font-semibold">New backtest</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Rules are checked at each session&apos;s close on what was known then, and orders fill at
          the next open with the costs you set. Stored prices run from {formatDate(first?.date)} to{" "}
          {formatDate(latest)}.
        </p>
      </div>
      <Card>
        <CardContent>
          <BacktestBuilder
            action={queueBacktest}
            initialName={initialName}
            initial={initial}
            defaults={defaults}
            presets={examples}
            riskFreeStored={rates !== undefined}
          />
        </CardContent>
      </Card>
    </div>
  );
}
