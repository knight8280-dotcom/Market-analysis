import type { EquityMetrics, Strategy } from "@market/backtest";
import { checkRunRequest, OBJECTIVE_LABELS, type Objective } from "@market/backtest/request";
import { resolveStrategy } from "@market/backtest/schema";
import { COPY, HypotheticalDisclosure } from "@market/compliance";
import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import { ProviderId } from "@market/market-data";
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  Delta,
  formatDate,
  formatDateTimeET,
  formatNumber,
  formatPercent,
  formatPrice,
  MISSING,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DrawdownChart } from "../../../../components/backtest/drawdown-chart";
import { KIND_LABEL, STATUS } from "../../../../components/backtest/labels";
import { RunRefresh } from "../../../../components/backtest/run-refresh";
import {
  costWords,
  DefinitionTable,
  MetricsTable,
  MonthlyTable,
  StrategyRules,
  TradeLog,
  TradeStats,
} from "../../../../components/backtest/sections";
import {
  formatObjective,
  SweepGrid,
  type SweepRow,
} from "../../../../components/backtest/sweep-grid";
import { PerformanceChart } from "../../../../components/performance-chart";
import { requireOwner } from "../../../../server/auth/owner";
import { getRun, sameRequestRuns, type RunDetail } from "../../../../server/backtests";
import { requireFlag } from "../../../../server/flags";
import { assertDisplayable, sourceInfo } from "../../../../server/market";
import { cancelBacktest, deleteBacktest, rerunBacktest } from "../actions";

export const metadata: Metadata = { title: "Backtest" };

interface SplitValidation {
  kind: "split";
  split: string;
  inSample: EquityMetrics | null;
  outOfSample: EquityMetrics | null;
}
interface SweepValidation {
  kind: "sweep";
  objective: Objective;
  params: Record<string, number[]>;
  rows: SweepRow[];
  best: SweepRow | null;
  combinations: number;
  warning: string | null;
}
interface WalkForwardValidation {
  kind: "walk_forward";
  objective: Objective;
  params: Record<string, number[]>;
  trainMonths: number;
  testMonths: number;
  windows: {
    trainStart: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    chosen: Record<string, number> | null;
    inSample: SweepRow["summary"];
    outOfSample: SweepRow["summary"];
  }[];
  dates: string[];
  equity: number[];
  metrics: EquityMetrics | null;
  benchmark: { ticker: string; values: (number | null)[]; metrics: EquityMetrics | null } | null;
  combinations: number;
  warning: string | null;
}
type Validation = SplitValidation | SweepValidation | WalkForwardValidation;

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border bg-surface p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

const values = (v: Record<string, number> | null) =>
  v
    ? Object.entries(v)
        .map(([k, x]) => `${k} = ${x}`)
        .join(", ")
    : MISSING;

/** The strategy to describe: as run, or with the best (or first) parameter values. */
function displayStrategy(run: RunDetail): { strategy: Strategy | null; varied: string | null } {
  if (run.report) return { strategy: run.report.strategy, varied: null };
  try {
    const checked = checkRunRequest(run.request);
    if (checked.request.kind === "single") return { strategy: checked.strategy, varied: null };
    const params = checked.request.params;
    return {
      strategy: resolveStrategy(checked.request.strategy, checked.combinations[0]),
      varied: Object.entries(params)
        .map(([k, v]) => `${k} ∈ {${v.join(", ")}}`)
        .join("; "),
    };
  } catch {
    return { strategy: null, varied: null };
  }
}

function Actions({ run }: { run: RunDetail }) {
  return (
    <div className="flex flex-wrap gap-2">
      <form action={rerunBacktest}>
        <input type="hidden" name="id" value={run.id} />
        <Button type="submit" variant="secondary">
          Run again
        </Button>
      </form>
      <Link
        href={`/backtests/new?run=${run.id}`}
        className={buttonVariants({ variant: "secondary" })}
      >
        Edit as new
      </Link>
      {run.status === "queued" ? (
        <form action={cancelBacktest}>
          <input type="hidden" name="id" value={run.id} />
          <Button type="submit" variant="secondary">
            Cancel
          </Button>
        </form>
      ) : null}
      {run.status !== "running" ? (
        <form action={deleteBacktest}>
          <input type="hidden" name="id" value={run.id} />
          <Button type="submit" variant="destructive" aria-label={`Delete run ${run.id}`}>
            Delete
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** One backtest run (Phase 2 step B8): status while it runs, then its full report. */
export default async function BacktestRunPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  await requireFlag("backtests");
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const status = STATUS[run.status] ?? STATUS.queued!;
  const { strategy, varied } = displayStrategy(run);
  const validation = run.validation as Validation | null;
  const inputs = run.inputs;
  const source = inputs ? ProviderId.parse(inputs.source) : null;
  if (source) assertDisplayable(source, "daily_bars", loadWebEnv().APP_ENV);
  const earlier = run.status === "succeeded" ? await sameRequestRuns(run) : [];

  const report = run.report;
  const wf = validation?.kind === "walk_forward" ? validation : null;
  const sweep = validation?.kind === "sweep" ? validation : null;
  const split = validation?.kind === "split" ? validation : null;
  const capital = strategy?.initialCapital ?? 1;
  const benchmarkLabel = report?.benchmark?.ticker ?? wf?.benchmark?.ticker ?? null;
  const label = source ? (
    <DataLabel source={sourceInfo(source)} kind="eod" asOf={inputs?.runTo ?? null} />
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <RunRefresh status={run.status} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href="/backtests" className="underline underline-offset-2">
              Backtests
            </Link>{" "}
            / run {run.id}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
            <span className="break-words">{run.name}</span>
            <Badge tone={status.tone} data-testid="run-status">
              {status.label}
            </Badge>
            <Badge>{KIND_LABEL[run.kind] ?? run.kind}</Badge>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Requested {formatDateTimeET(run.createdAt)}
            {run.finishedAt ? ` · finished ${formatDateTimeET(run.finishedAt)}` : ""}
          </p>
        </div>
        <Actions run={run} />
      </div>

      {run.status === "queued" || run.status === "running" ? (
        <Card>
          <CardContent className="flex flex-col gap-2 py-6" role="status">
            <p className="font-medium">
              {run.status === "queued" ? "Waiting for the worker…" : "Running…"}
            </p>
            <p className="text-sm text-muted-foreground">
              This page updates by itself. The worker picks up queued runs within a few seconds; if
              this one stays queued, check that the worker is running (
              <code className="font-mono text-xs">pnpm --filter @market/worker start</code>) or run{" "}
              <code className="font-mono text-xs">pnpm worker backtests</code> once.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {run.status === "failed" ? (
        <Card>
          <CardContent className="py-6">
            <p role="alert" className="text-sm">
              <span className="font-medium text-down">The run failed: </span>
              <span data-testid="run-error">{run.error}</span>
            </p>
          </CardContent>
        </Card>
      ) : null}

      {run.status === "cancelled" ? (
        <p className="text-sm text-muted-foreground">This run was cancelled before it started.</p>
      ) : null}

      {run.status === "succeeded" && strategy ? (
        <>
          <HypotheticalDisclosure>
            {COPY.backtestDisclosure(costWords(strategy))}
          </HypotheticalDisclosure>
          {sweep ? (
            <p role="note" className="rounded-lg border border-warning/60 px-4 py-3 text-sm">
              {COPY.sweepBest(sweep.combinations, OBJECTIVE_LABELS[sweep.objective])}{" "}
              {sweep.warning ?? ""}
              <span className="mt-1 block text-muted-foreground">
                Shown below: {values(sweep.best?.values ?? null)}.
              </span>
            </p>
          ) : null}
          {wf ? (
            <p role="note" className="rounded-lg border px-4 py-3 text-sm">
              Out-of-sample record: each {wf.testMonths}-month test window ran the parameters that
              scored best by {OBJECTIVE_LABELS[wf.objective]} on the {wf.trainMonths} months before
              it, and the windows are chained. Each window starts in cash. {wf.warning ?? ""}
            </p>
          ) : null}

          <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat
              label="Total return"
              value={<Delta fraction={run.summary?.totalReturn} />}
              detail={
                benchmarkLabel
                  ? `${benchmarkLabel}: ${formatPercent(run.summary?.benchmarkTotalReturn)}`
                  : "No benchmark"
              }
              testId="stat-total-return"
            />
            <Stat label="CAGR" value={formatPercent(run.summary?.cagr)} />
            <Stat
              label="Sharpe ratio"
              value={run.summary?.sharpe === null ? MISSING : formatNumber(run.summary?.sharpe)}
              detail={inputs?.riskFree.available ? "vs 3-month T-bill" : "No T-bill rate stored"}
            />
            <Stat
              label="Max drawdown"
              value={
                run.summary?.maxDrawdown === null || run.summary?.maxDrawdown === undefined
                  ? MISSING
                  : formatPercent(-run.summary.maxDrawdown)
              }
            />
            <Stat label="Closed trades" value={run.summary?.trades ?? MISSING} />
          </section>

          {report ? (
            <Card>
              <CardHeader title="Equity and benchmark" description={label} />
              <CardContent className="flex flex-col gap-4">
                <PerformanceChart
                  dates={report.series.dates}
                  portfolio={report.series.equity.map((v) => v / capital)}
                  benchmark={
                    report.benchmark
                      ? report.series.benchmark.map((v) => (v === null ? null : v / capital))
                      : null
                  }
                  benchmarkLabel={benchmarkLabel}
                  label="Strategy"
                  legend="Strategy (hypothetical)"
                />
                <DrawdownChart dates={report.series.dates} drawdown={report.series.drawdown} />
              </CardContent>
            </Card>
          ) : null}

          {wf && wf.metrics ? (
            <Card>
              <CardHeader title="Out-of-sample equity and benchmark" description={label} />
              <CardContent>
                <PerformanceChart
                  dates={wf.dates}
                  portfolio={wf.equity.map((v) => v / capital)}
                  benchmark={
                    wf.benchmark
                      ? wf.benchmark.values.map((v) => (v === null ? null : v / capital))
                      : null
                  }
                  benchmarkLabel={benchmarkLabel}
                  label="Strategy out of sample"
                  legend="Strategy, test windows chained (hypothetical)"
                />
              </CardContent>
            </Card>
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title={wf ? "Performance out of sample" : "Performance"} />
              <CardContent>
                {report ? (
                  <MetricsTable
                    strategy={report.metrics}
                    benchmark={report.benchmark?.metrics ?? null}
                    benchmarkLabel={benchmarkLabel}
                    caption="Strategy and benchmark measures"
                  />
                ) : wf?.metrics ? (
                  <MetricsTable
                    strategy={wf.metrics}
                    benchmark={wf.benchmark?.metrics ?? null}
                    benchmarkLabel={benchmarkLabel}
                    caption="Out-of-sample strategy and benchmark measures"
                  />
                ) : null}
                {report?.benchmark && report.benchmark.from !== report.sessions.first ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Benchmark prices start on {formatDate(report.benchmark.from)}; its measures
                    cover that period.
                  </p>
                ) : null}
              </CardContent>
            </Card>
            {report ? (
              <Card>
                <CardHeader title="Trades" />
                <CardContent>
                  <TradeStats metrics={report.metrics} />
                </CardContent>
              </Card>
            ) : null}
          </div>

          {split ? (
            <Card>
              <CardHeader
                title="In sample and out of sample"
                description={`The same strategy before and from ${formatDate(split.split)}.`}
              />
              <CardContent>
                <Table aria-label="In-sample and out-of-sample measures">
                  <thead>
                    <tr>
                      <Th>Measure</Th>
                      <Th numeric>Before {formatDate(split.split)}</Th>
                      <Th numeric>From {formatDate(split.split)}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Total return", (m: EquityMetrics) => formatPercent(m.totalReturn)],
                        ["CAGR", (m: EquityMetrics) => formatPercent(m.cagr)],
                        [
                          "Sharpe ratio",
                          (m: EquityMetrics) =>
                            m.sharpe === null ? MISSING : formatNumber(m.sharpe),
                        ],
                        ["Max drawdown", (m: EquityMetrics) => formatPercent(-m.maxDrawdown)],
                      ] as const
                    ).map(([name, f]) => (
                      <tr key={name}>
                        <Th scope="row" className="font-normal text-foreground">
                          {name}
                        </Th>
                        <Td numeric className="tabular-nums">
                          {split.inSample ? f(split.inSample) : MISSING}
                        </Td>
                        <Td numeric className="tabular-nums">
                          {split.outOfSample ? f(split.outOfSample) : MISSING}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {sweep ? (
            <Card>
              <CardHeader
                title="Parameter sweep"
                description={`${sweep.combinations} combinations by ${OBJECTIVE_LABELS[sweep.objective]}; the outlined cell is the one shown above.`}
              />
              <CardContent>
                <SweepGrid
                  objective={sweep.objective}
                  params={sweep.params}
                  rows={sweep.rows}
                  best={sweep.best?.values ?? null}
                />
              </CardContent>
            </Card>
          ) : null}

          {wf ? (
            <Card>
              <CardHeader title="Walk-forward windows" />
              <CardContent>
                <Table
                  aria-label="Walk-forward windows"
                  scrollLabel="Walk-forward windows, scrollable"
                >
                  <thead>
                    <tr>
                      <Th>Training</Th>
                      <Th>Test</Th>
                      <Th>Chosen</Th>
                      <Th numeric>{OBJECTIVE_LABELS[wf.objective]} in training</Th>
                      <Th numeric>Test return</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {wf.windows.map((w) => (
                      <tr key={w.testStart}>
                        <Td className="whitespace-nowrap">
                          {formatDate(w.trainStart)} – {formatDate(w.trainEnd)}
                        </Td>
                        <Td className="whitespace-nowrap">
                          {formatDate(w.testStart)} – {formatDate(w.testEnd)}
                        </Td>
                        <Td>{values(w.chosen)}</Td>
                        <Td numeric className="tabular-nums">
                          {formatObjective(
                            w.inSample
                              ? (
                                  {
                                    cagr: w.inSample.cagr,
                                    sharpe: w.inSample.sharpe,
                                    calmar: w.inSample.calmar,
                                    total_return: w.inSample.totalReturn,
                                  } as Record<Objective, number | null>
                                )[wf.objective]
                              : null,
                            wf.objective,
                          )}
                        </Td>
                        <Td numeric className="tabular-nums">
                          {w.outOfSample ? <Delta fraction={w.outOfSample.totalReturn} /> : MISSING}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {report ? (
            <>
              <Card>
                <CardHeader title="Monthly returns" />
                <CardContent>
                  <MonthlyTable monthly={report.monthly} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader
                  title="Trade log"
                  description={`${report.trades.length} trades, in order of entry. Prices are as traded on the day; a split in between changes the share count, not the return.`}
                />
                <CardContent>
                  <TradeLog trades={report.trades} />
                </CardContent>
              </Card>
            </>
          ) : null}
        </>
      ) : null}

      {strategy ? (
        <Card>
          <CardHeader
            title="Assumptions"
            description="Everything this run used, so it can be checked and repeated."
          />
          <CardContent className="flex flex-col gap-4">
            <StrategyRules strategy={strategy} />
            <DefinitionTable
              label="Run assumptions"
              rows={[
                [
                  "Test period",
                  inputs
                    ? `${formatDate(inputs.runFrom)} – ${formatDate(inputs.runTo)} (requested ${formatDate(strategy.start)} – ${formatDate(strategy.end)})`
                    : `${formatDate(strategy.start)} – ${formatDate(strategy.end)}`,
                ],
                ...(varied ? ([["Parameters tried", varied]] as [string, string][]) : []),
                ["Starting capital", formatPrice(strategy.initialCapital)],
                [
                  "Signals and fills",
                  "Rules are checked at each close; orders fill at the next session's open",
                ],
                ["Commissions", costWords(strategy).commissions],
                ["Slippage", `${costWords(strategy).slippage} against each fill`],
                [
                  "Dividends",
                  strategy.dividends === "reinvest"
                    ? "Reinvested at the ex-date open, without commission"
                    : "Kept as cash",
                ],
                [
                  "Shares",
                  strategy.fractionalShares ? "Fractional shares allowed" : "Whole shares only",
                ],
                [
                  "Benchmark",
                  strategy.benchmark
                    ? `${strategy.benchmark} total return${inputs?.benchmark && !inputs.benchmark.available ? " (no prices stored)" : ""}`
                    : "None",
                ],
                ...(inputs
                  ? ([
                      [
                        "Prices",
                        <span key="p" className="flex flex-col gap-1">
                          <span>
                            End-of-day bars as traded, with split and dividend factors; data through{" "}
                            {formatDate(inputs.runTo)}
                          </span>
                          {label}
                        </span>,
                      ],
                      [
                        "Warm-up",
                        `${inputs.warmupSessions} sessions before the start, loaded from ${formatDate(inputs.loadedFrom)}`,
                      ],
                      [
                        "Securities",
                        `${inputs.securities.length} (${inputs.securities.filter((s) => s.delistedAt).length} delisted)`,
                      ],
                      [
                        "Risk-free rate",
                        inputs.riskFree.available
                          ? "3-month T-bill, FRED DTB3"
                          : "Not stored, so Sharpe and Sortino are unavailable",
                      ],
                    ] as [string, React.ReactNode][])
                  : []),
                ...(run.codeVersion
                  ? ([["Code version", run.codeVersion]] as [string, string][])
                  : []),
                ...(run.dataSnapshotId
                  ? ([
                      [
                        "Data fingerprint",
                        <span
                          key="f"
                          className="font-mono text-xs break-all"
                          data-testid="snapshot-id"
                        >
                          {run.dataSnapshotId}
                        </span>,
                      ],
                    ] as [string, React.ReactNode][])
                  : []),
              ]}
            />
            {earlier.length ? (
              <ul
                className="flex flex-col gap-1 text-sm"
                aria-label="Earlier runs of the same request"
              >
                {earlier.map((e) => (
                  <li key={e.id}>
                    <Link href={`/backtests/${e.id}`} className="underline underline-offset-2">
                      Run {e.id}
                    </Link>{" "}
                    ({formatDateTimeET(e.createdAt)}):{" "}
                    {e.dataSnapshotId === run.dataSnapshotId
                      ? "same request on the same data"
                      : "same request, different data (prices were added or corrected since)"}
                  </li>
                ))}
              </ul>
            ) : null}
            {[...(inputs?.notes ?? []), ...(report?.warnings ?? [])].length ? (
              <ul
                className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground"
                aria-label="Data notes"
              >
                {[...(inputs?.notes ?? []), ...(report?.warnings ?? [])].map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
