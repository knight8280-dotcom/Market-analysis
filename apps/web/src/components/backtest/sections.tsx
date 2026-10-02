import type { EquityMetrics, MonthlyReturn, Strategy, Trade } from "@market/backtest";
import { describeOperand, describeRule } from "@market/backtest/schema";
import {
  Delta,
  formatDate,
  formatNumber,
  formatPercent,
  formatPrice,
  MISSING,
  Table,
  Td,
  Th,
} from "@market/ui";

/** Building blocks of the backtest report page (Phase 2 step B8). */

const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? MISSING : formatPercent(v, digits);
const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? MISSING : formatNumber(v, digits);
const sessions = (n: number | null | undefined) =>
  n === null || n === undefined ? MISSING : `${n} session${n === 1 ? "" : "s"}`;

/** Costs and fills in words, for the disclosure and the assumptions panel. */
export function costWords(s: Strategy) {
  const c = s.costs;
  const parts = [
    c.commissionPerTrade > 0 ? `${formatPrice(c.commissionPerTrade)} per trade` : null,
    c.commissionBps > 0 ? `${formatNumber(c.commissionBps, 1)} bps of value` : null,
  ].filter(Boolean);
  return {
    commissions: parts.length ? parts.join(" plus ") : "none",
    slippage: c.slippageBps > 0 ? `${formatNumber(c.slippageBps, 1)} bps` : "none",
    fills: "the next session's open",
  };
}

const METRIC_ROWS: {
  label: string;
  key: keyof EquityMetrics;
  format: (v: number | null) => string;
  note?: string;
}[] = [
  { label: "Total return", key: "totalReturn", format: (v) => pct(v) },
  {
    label: "CAGR",
    key: "cagr",
    format: (v) => pct(v),
    note: "Compound annual growth, 365.25-day years",
  },
  { label: "Volatility (annualized)", key: "volatility", format: (v) => pct(v) },
  {
    label: "Sharpe ratio",
    key: "sharpe",
    format: (v) => num(v),
    note: "Excess daily return over the 3-month T-bill (FRED DTB3), annualized with √252",
  },
  {
    label: "Sortino ratio",
    key: "sortino",
    format: (v) => num(v),
    note: "As Sharpe, with downside deviation",
  },
  {
    label: "Max drawdown",
    key: "maxDrawdown",
    format: (v) => (v === null ? MISSING : formatPercent(-v)),
  },
  {
    label: "Longest drawdown",
    key: "maxDrawdownDuration",
    format: (v) => sessions(v),
    note: "Sessions from a peak until it was regained, or to the end",
  },
  { label: "Calmar ratio", key: "calmar", format: (v) => num(v), note: "CAGR ÷ max drawdown" },
  { label: "Best month", key: "bestMonth", format: (v) => pct(v) },
  { label: "Worst month", key: "worstMonth", format: (v) => pct(v) },
];

/** Strategy and benchmark side by side (spec §12: benchmark results shown alongside). */
export function MetricsTable({
  strategy,
  benchmark,
  benchmarkLabel,
  caption,
}: {
  strategy: EquityMetrics;
  benchmark: EquityMetrics | null;
  benchmarkLabel: string | null;
  caption: string;
}) {
  return (
    <Table aria-label={caption}>
      <thead>
        <tr>
          <Th>Measure</Th>
          <Th numeric>Strategy</Th>
          <Th numeric>{benchmarkLabel ? `${benchmarkLabel} (benchmark)` : "Benchmark"}</Th>
        </tr>
      </thead>
      <tbody>
        {METRIC_ROWS.map((r) => (
          <tr key={r.key}>
            <Th scope="row" className="font-normal text-foreground">
              {r.label}
              {r.note ? (
                <span className="block text-[11px] text-muted-foreground">{r.note}</span>
              ) : null}
            </Th>
            <Td numeric className="tabular-nums">
              {r.format(strategy[r.key])}
            </Td>
            <Td numeric className="tabular-nums">
              {benchmark ? r.format(benchmark[r.key]) : "Unavailable"}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function TradeStats({
  metrics,
}: {
  metrics: {
    trades: number;
    openTrades: number;
    winRate: number | null;
    profitFactor: number | null;
    averageWin: number | null;
    averageLoss: number | null;
    averageSessionsHeld: number | null;
    exposure: number;
    turnover: number | null;
  };
}) {
  const rows: [string, string, string?][] = [
    ["Closed trades", String(metrics.trades)],
    ["Still open at the end", String(metrics.openTrades)],
    ["Win rate", pct(metrics.winRate, 1), "Closed trades with a gain, after costs"],
    ["Profit factor", num(metrics.profitFactor), "Gross gains ÷ gross losses"],
    ["Average gain", metrics.averageWin === null ? MISSING : formatPrice(metrics.averageWin)],
    ["Average loss", metrics.averageLoss === null ? MISSING : formatPrice(metrics.averageLoss)],
    [
      "Average holding",
      sessions(
        metrics.averageSessionsHeld === null ? null : Math.round(metrics.averageSessionsHeld),
      ),
    ],
    ["Exposure", pct(metrics.exposure, 1), "Average share of equity invested"],
    ["Turnover (annual)", pct(metrics.turnover, 0), "Traded value ÷ 2 ÷ average equity, per year"],
  ];
  return (
    <Table aria-label="Trade statistics">
      <tbody>
        {rows.map(([label, value, note]) => (
          <tr key={label}>
            <Th scope="row" className="font-normal text-foreground">
              {label}
              {note ? (
                <span className="block text-[11px] text-muted-foreground">{note}</span>
              ) : null}
            </Th>
            <Td numeric className="tabular-nums">
              {value}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monthly returns by year, with each year's compounded total. */
export function MonthlyTable({ monthly }: { monthly: MonthlyReturn[] }) {
  const years = [...new Set(monthly.map((m) => m.month.slice(0, 4)))];
  const of = (y: string, i: number) =>
    monthly.find((m) => m.month === `${y}-${String(i + 1).padStart(2, "0")}`);
  return (
    <Table
      aria-label="Monthly returns"
      scrollLabel="Monthly returns, scrollable"
      className="text-xs"
    >
      <thead>
        <tr>
          <Th>Year</Th>
          {MONTHS.map((m) => (
            <Th key={m} numeric>
              {m}
            </Th>
          ))}
          <Th numeric>Year</Th>
        </tr>
      </thead>
      <tbody>
        {years.map((y) => {
          const months = monthly.filter((m) => m.month.startsWith(y));
          const total = months.reduce((acc, m) => acc * (1 + m.return), 1) - 1;
          return (
            <tr key={y}>
              <Th scope="row" className="text-foreground">
                {y}
              </Th>
              {MONTHS.map((m, i) => {
                const r = of(y, i);
                return (
                  <Td key={m} numeric className="px-1.5 tabular-nums">
                    {r ? <Delta fraction={r.return} digits={1} /> : ""}
                  </Td>
                );
              })}
              <Td numeric className="px-1.5 font-medium tabular-nums">
                <Delta fraction={total} digits={1} />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

const REASON: Record<string, string> = {
  entry: "Entry",
  rebalance: "Rebalance",
  exit_rule: "Exit rule",
  stop_loss: "Stop loss",
  take_profit: "Take profit",
  max_hold: "Holding limit",
  delisted: "Delisted",
  open: "Still open",
};
export const TRADE_LOG_LIMIT = 500;

export function TradeLog({ trades }: { trades: Trade[] }) {
  const shown = trades.slice(0, TRADE_LOG_LIMIT);
  return (
    <div className="flex flex-col gap-2">
      <Table aria-label="Trade log" scrollLabel="Trade log, scrollable">
        <thead>
          <tr>
            <Th>Ticker</Th>
            <Th>Entry</Th>
            <Th numeric>Entry price</Th>
            <Th>Exit</Th>
            <Th numeric>Exit price</Th>
            <Th>Reason</Th>
            <Th numeric>Sessions</Th>
            <Th numeric>P&amp;L</Th>
            <Th numeric>Return</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={`${t.securityId}-${t.entryDate}-${i}`}>
              <Td className="font-medium">{t.ticker}</Td>
              <Td className="whitespace-nowrap">{formatDate(t.entryDate)}</Td>
              <Td numeric className="tabular-nums">
                {formatPrice(t.entryPrice)}
              </Td>
              <Td className="whitespace-nowrap">{t.exitDate ? formatDate(t.exitDate) : MISSING}</Td>
              <Td numeric className="tabular-nums">
                {t.exitPrice === null ? MISSING : formatPrice(t.exitPrice)}
              </Td>
              <Td>{REASON[t.exitReason] ?? t.exitReason}</Td>
              <Td numeric className="tabular-nums">
                {t.sessionsHeld}
              </Td>
              <Td numeric className="tabular-nums">
                {formatPrice(t.pnl)}
              </Td>
              <Td numeric className="tabular-nums">
                <Delta fraction={t.returnPct} digits={1} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {trades.length > shown.length ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {shown.length} of {trades.length} trades.
        </p>
      ) : null}
    </div>
  );
}

/** The strategy as it ran, in words. */
export function StrategyRules({ strategy: s }: { strategy: Strategy }) {
  const universe =
    s.universe.kind === "tickers"
      ? s.universe.tickers.join(", ")
      : { equity: "All stored stocks", etf: "All stored ETFs", any: "All stored stocks and ETFs" }[
          s.universe.assetClass
        ] + " (delisted ones included)";
  const rows: [string, string][] = [
    ["Universe", universe],
    ["Enter when", describeRule(s.entry)],
    ["Exit when", s.exit ? describeRule(s.exit) : "No exit rule"],
    [
      "Stops",
      [
        s.stops.stopLossPct !== null ? `stop loss ${formatPercent(-s.stops.stopLossPct, 1)}` : null,
        s.stops.takeProfitPct !== null
          ? `take profit ${formatPercent(s.stops.takeProfitPct, 1)}`
          : null,
        s.stops.maxHoldingDays !== null ? `sell after ${sessions(s.stops.maxHoldingDays)}` : null,
      ]
        .filter(Boolean)
        .join("; ") || "None",
    ],
    [
      "Positions",
      `Up to ${s.sizing.maxPositions}, equal weight${s.rank ? `; candidates ranked by ${describeOperand(s.rank.by)} (${s.rank.order === "asc" ? "lowest" : "highest"} first)` : ""}`,
    ],
    [
      "Rebalancing",
      s.rebalance === "none"
        ? "None (positions keep their weight)"
        : `Back to equal weight ${s.rebalance}`,
    ],
  ];
  return <DefinitionTable rows={rows} label="Strategy rules" />;
}

export function DefinitionTable({
  rows,
  label,
}: {
  rows: [string, React.ReactNode][];
  label: string;
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]"
    >
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
