import { COPY, HypotheticalDisclosure } from "@market/compliance";
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  Delta,
  EmptyState,
  formatDate,
  formatDateTimeET,
  formatNumber,
  formatPercent,
  MISSING,
  Table,
  Td,
  Th,
} from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { KIND_LABEL, STATUS } from "../../../components/backtest/labels";
import { RunRefresh } from "../../../components/backtest/run-refresh";
import { requireOwner } from "../../../server/auth/owner";
import { listRuns, listStrategies } from "../../../server/backtests";
import { requireFlag } from "../../../server/flags";
import { deleteStrategy } from "./actions";

export const metadata: Metadata = { title: "Backtests" };

/** Backtest runs and saved strategies (Phase 2 step B8). */
export default async function BacktestsPage() {
  await requireOwner();
  await requireFlag("backtests");
  const [runs, strategies] = await Promise.all([listRuns(), listStrategies()]);
  const pending = runs.some((r) => r.status === "queued" || r.status === "running");
  const newButton = (
    <Link href="/backtests/new" className={buttonVariants({ variant: "primary" })}>
      New backtest
    </Link>
  );

  return (
    <div className="flex flex-col gap-6">
      <RunRefresh status={pending ? "running" : "done"} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Backtests</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Test rules you define on stored end-of-day history, delisted securities included.
            Signals use only what was known at each close and fill at the next open, with the costs
            you set.
          </p>
        </div>
        {runs.length ? newButton : null}
      </div>

      {runs.length === 0 ? (
        <Card>
          <EmptyState title="Test an idea on past data" action={newButton}>
            Build entry and exit rules from indicators, prices and fundamentals, then see how they
            would have traded, next to a benchmark.
          </EmptyState>
        </Card>
      ) : (
        <>
          <HypotheticalDisclosure>{COPY.backtestListDisclosure}</HypotheticalDisclosure>
          <Card>
            <CardHeader title="Runs" description="Newest first." />
            <CardContent>
              <Table aria-label="Backtest runs" scrollLabel="Backtest runs, scrollable">
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Type</Th>
                    <Th>Status</Th>
                    <Th>Period</Th>
                    <Th numeric>Total return</Th>
                    <Th numeric className="hidden md:table-cell">
                      Benchmark
                    </Th>
                    <Th numeric className="hidden lg:table-cell">
                      CAGR
                    </Th>
                    <Th numeric className="hidden lg:table-cell">
                      Sharpe
                    </Th>
                    <Th numeric className="hidden lg:table-cell">
                      Max drawdown
                    </Th>
                    <Th className="hidden 2xl:table-cell">Requested</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const s = r.summary;
                    const status = STATUS[r.status] ?? STATUS.queued!;
                    return (
                      <tr key={r.id} data-testid={`run-${r.id}`}>
                        <Td className="max-w-56 min-w-36">
                          <Link
                            href={`/backtests/${r.id}`}
                            className="font-medium break-words underline-offset-2 hover:underline"
                          >
                            {r.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">#{r.id}</span>
                        </Td>
                        <Td className="whitespace-nowrap">{KIND_LABEL[r.kind] ?? r.kind}</Td>
                        <Td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {s?.first ? `${formatDate(s.first)} – ${formatDate(s.last)}` : MISSING}
                        </Td>
                        <Td numeric className="tabular-nums">
                          {s ? <Delta fraction={s.totalReturn} /> : MISSING}
                        </Td>
                        <Td numeric className="hidden tabular-nums md:table-cell">
                          {s ? formatPercent(s.benchmarkTotalReturn) : MISSING}
                        </Td>
                        <Td numeric className="hidden tabular-nums lg:table-cell">
                          {s ? formatPercent(s.cagr) : MISSING}
                        </Td>
                        <Td numeric className="hidden tabular-nums lg:table-cell">
                          {s?.sharpe === null || s?.sharpe === undefined
                            ? MISSING
                            : formatNumber(s.sharpe)}
                        </Td>
                        <Td numeric className="hidden tabular-nums lg:table-cell">
                          {s?.maxDrawdown === null || s?.maxDrawdown === undefined
                            ? MISSING
                            : formatPercent(-s.maxDrawdown)}
                        </Td>
                        <Td className="hidden whitespace-nowrap text-xs text-muted-foreground 2xl:table-cell">
                          {formatDateTimeET(r.createdAt)}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {strategies.length ? (
        <Card>
          <CardHeader
            title="Saved strategies"
            description="Open one in the builder to run it again or change it."
          />
          <CardContent>
            <ul className="flex flex-col divide-y" aria-label="Saved strategies">
              {strategies.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      saved {formatDateTimeET(s.updatedAt)}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <Link
                      href={`/backtests/new?strategy=${s.id}`}
                      className={buttonVariants({ variant: "secondary", size: "sm" })}
                    >
                      Open
                    </Link>
                    <form action={deleteStrategy}>
                      <input type="hidden" name="id" value={s.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete strategy ${s.name}`}
                      >
                        Delete
                      </Button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
