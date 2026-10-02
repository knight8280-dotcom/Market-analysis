import type { PortfolioRisk } from "@market/portfolio";
import {
  Card,
  CardContent,
  CardHeader,
  formatDate,
  formatNumber,
  formatPercent,
  formatPrice,
  MISSING,
  Table,
  Td,
  Th,
} from "@market/ui";
import { Tooltip } from "@market/ui/client";
import { Info } from "lucide-react";

/**
 * Portfolio risk (Phase 2 step C2): each measure with its method and data source in a tooltip
 * (spec §5.10), the holdings' correlations and recent daily P&L.
 */

const RF =
  "the 3-month T-bill rate (FRED DTB3), latest observation on or before each session, ÷ 252";
const MATRIX_LIMIT = 10;

function Measure({
  label,
  value,
  detail,
  method,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  method: string;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border bg-surface p-3" data-testid={testId}>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        <Tooltip content={method}>
          <button
            type="button"
            aria-label={`How ${label.toLowerCase()} is measured`}
            className="inline-flex size-6 items-center justify-center rounded hover:bg-muted"
          >
            <Info aria-hidden className="size-3.5" />
          </button>
        </Tooltip>
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/** A ratio, with values that round to zero shown as 0 (never "−0.00"). */
const num = (v: number | null, digits = 2) =>
  v === null ? MISSING : formatNumber(Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v, digits);
const share = (v: number | null | undefined) =>
  v === null || v === undefined ? MISSING : formatPercent(v, 1).replace("+", "");

export function RiskPanel({
  risk,
  benchmark,
  riskFreeStored,
  tickers,
}: {
  risk: PortfolioRisk;
  benchmark: string | null;
  riskFreeStored: boolean;
  tickers: (securityId: string) => string;
}) {
  const s = risk.sessions;
  const lastPnl = risk.dailyPnl.at(-1) ?? null;
  const recent = risk.dailyPnl.slice(-10).reverse();
  const m = risk.correlations;
  const shown = m ? m.securityIds.slice(0, MATRIX_LIMIT) : [];
  const noRates = riskFreeStored ? "Too few sessions yet" : "No T-bill rates stored";

  return (
    <Card>
      <CardHeader
        title="Risk"
        description={
          s
            ? `Measured on the time-weighted return at each session, ${formatDate(s.first)} to ${formatDate(s.last)} (${s.count} sessions); deposits and withdrawals do not count as gains or losses.`
            : "Risk measures need at least two sessions of history."
        }
      />
      <CardContent className="flex flex-col gap-6">
        <section aria-label="Risk measures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Measure
            label="Volatility"
            testId="risk-volatility"
            value={
              risk.volatility === null ? MISSING : formatPercent(risk.volatility).replace("+", "")
            }
            detail="a year"
            method="Sample standard deviation of daily time-weighted returns, × √252 to annualize."
          />
          <Measure
            label="Sharpe ratio"
            testId="risk-sharpe"
            value={num(risk.sharpe)}
            detail={risk.sharpe === null ? noRates : "vs 3-month T-bill"}
            method={`Average daily return above ${RF}, divided by the standard deviation of those excess returns, × √252.`}
          />
          <Measure
            label="Sortino ratio"
            value={num(risk.sortino)}
            detail={risk.sortino === null ? noRates : "vs 3-month T-bill"}
            method={`Average daily return above ${RF}, divided by the downside deviation (root mean square of the returns below it), × √252.`}
          />
          <Measure
            label={benchmark ? `Beta vs ${benchmark}` : "Beta"}
            testId="risk-beta"
            value={num(risk.beta)}
            detail={
              benchmark
                ? `${risk.benchmarkObservations} paired sessions`
                : "No benchmark prices loaded"
            }
            method="Covariance of the portfolio's daily returns with the benchmark's, divided by the variance of the benchmark's (total return, dividends reinvested)."
          />
          <Measure
            label={benchmark ? `Correlation with ${benchmark}` : "Correlation"}
            value={num(risk.correlation)}
            detail="−1 to 1"
            method="Pearson correlation of daily returns with the benchmark's, over the same paired sessions as beta."
          />
          <Measure
            label="Longest drawdown"
            value={
              risk.maxDrawdownDuration === null ? MISSING : `${risk.maxDrawdownDuration} sessions`
            }
            detail="peak until regained"
            method="Sessions from a peak of the time-weighted return until it was regained, or to the latest session if it has not been."
          />
          <Measure
            label="Top-10 weight"
            testId="risk-top10"
            value={share(risk.concentration?.top10)}
            detail={
              risk.concentration
                ? `of ${risk.concentration.count} holding${risk.concentration.count === 1 ? "" : "s"}`
                : "No holdings"
            }
            method="Share of the holdings' value in the ten largest positions. Cash is left out."
          />
          <Measure
            label="Concentration (HHI)"
            testId="risk-hhi"
            value={num(risk.concentration?.hhi ?? null)}
            detail={
              risk.concentration
                ? `like ${formatNumber(risk.concentration.effectiveCount, 1)} equal holdings`
                : undefined
            }
            method="Herfindahl–Hirschman index: the sum of each holding's squared weight (cash left out). 1 means one holding; 1 ÷ HHI is the number of equal-sized holdings with the same concentration."
          />
          <Measure
            label="Cash"
            value={share(risk.concentration?.cashWeight ?? null)}
            detail="of the portfolio's value"
            method="Uninvested cash as a share of the portfolio's total value."
          />
          <Measure
            label="Latest daily P&L"
            testId="risk-pnl"
            value={lastPnl ? formatPrice(lastPnl.pnl) : MISSING}
            detail={lastPnl ? formatDate(lastPnl.date) : undefined}
            method="The day's change in value, not counting money added or withdrawn that day."
          />
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <section aria-label="Correlation of holdings" className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-semibold">Correlation of holdings</h3>
            {m && shown.length >= 2 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Daily total returns, {formatDate(m.from)} to {formatDate(m.to)} ({m.sessions}{" "}
                  sessions), largest holdings first
                  {m.securityIds.length > MATRIX_LIMIT
                    ? ` (top ${MATRIX_LIMIT} of ${m.securityIds.length})`
                    : ""}
                  .
                </p>
                <Table
                  aria-label="Correlation of daily returns between holdings"
                  scrollLabel="Holdings correlation, scrollable"
                  className="text-xs"
                >
                  <thead>
                    <tr>
                      <Th>
                        <span className="sr-only">Holding</span>
                      </Th>
                      {shown.map((id) => (
                        <Th key={id} numeric className="font-mono">
                          {tickers(id)}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row, i) => (
                      <tr key={row}>
                        <Th scope="row" className="font-mono text-foreground">
                          {tickers(row)}
                        </Th>
                        {shown.map((col, j) => {
                          const v = m.matrix[i]![j] ?? null;
                          return (
                            <Td
                              key={col}
                              numeric
                              className="tabular-nums"
                              style={{
                                backgroundColor:
                                  v === null || i === j
                                    ? undefined
                                    : `color-mix(in srgb, var(--primary) ${Math.round(Math.abs(v) * 40)}%, transparent)`,
                              }}
                            >
                              {v === null ? MISSING : formatNumber(v, 2)}
                            </Td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Needs at least two holdings with a few weeks of prices.
              </p>
            )}
          </section>
          <section aria-label="Recent daily P&L" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Recent daily P&amp;L</h3>
            {recent.length ? (
              <ul className="flex flex-col text-sm">
                {recent.map((d) => (
                  <li
                    key={d.date}
                    className="flex justify-between gap-2 border-b border-border/60 py-1"
                  >
                    <span className="text-muted-foreground">{formatDate(d.date)}</span>
                    <span className="tabular-nums">{formatPrice(d.pnl)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No days yet.</p>
            )}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
