import type { BacktestData } from "./data";
import { lastIndexAtOrBefore } from "./data";
import { SecurityView } from "./operands";
import type { Comparison, Group, Strategy } from "./schema";

/**
 * The deterministic backtest engine (Phase 2 step B2; spec §5.15).
 *
 * Each session t, in order:
 * 1. splits and cash dividends with an ex-date since the previous session apply to positions
 *    held at the previous close (dividends paid on the ex-date; reinvested at that open, without
 *    commission, when dividends are reinvested);
 * 2. a position in a security delisted by t is closed at its last close, without costs;
 * 3. orders from the previous close fill at t's open: sells, then dividend reinvestment, then
 *    buys, in ranking order. Slippage moves the fill price against us; commission is a fixed
 *    amount per fill plus basis points of its value. A buy for a security that does not trade
 *    at t is cancelled; a sell waits for its next session;
 * 4. stop-loss and take-profit orders rest from the entry: a bar that opens through the level
 *    fills at the open, one that trades through it fills at the level; if both are hit the
 *    stop is assumed first;
 * 5. positions are marked at t's close (the last close when a security did not trade);
 * 6. rules are evaluated on data up to t's close and become orders for the next session. No
 *    signal fills on its own bar.
 *
 * Long only. Cash earns nothing. Values come from SecurityView, which keeps every rule to what
 * was known on its date.
 */

export const ENGINE_VERSION = "1";

export type FillReason =
  | "entry"
  | "rebalance"
  | "dividend_reinvest"
  | "exit_rule"
  | "stop_loss"
  | "take_profit"
  | "max_hold"
  | "delisted";

export interface Fill {
  date: string;
  securityId: string;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
  commission: number;
  reason: FillReason;
}

export interface Trade {
  securityId: string;
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: FillReason | "open";
  /** Money put in from outside the position (buys and commissions, less reinvested dividends). */
  invested: number;
  /** Sale proceeds net of commissions; for an open position, its value at the last close. */
  proceeds: number;
  dividends: number;
  commissions: number;
  pnl: number;
  returnPct: number;
  sessionsHeld: number;
}

export interface Simulation {
  dates: string[];
  equity: number[];
  cash: number[];
  /** Value of positions as a fraction of equity, at each close. */
  exposure: number[];
  positions: number[];
  /** The benchmark's total return over the same sessions, scaled to the initial capital. */
  benchmark: (number | null)[];
  trades: Trade[];
  fills: Fill[];
  warnings: string[];
}

export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestError";
  }
}

interface Position {
  view: SecurityView;
  shares: number;
  entryDate: string;
  entryIndex: number;
  entryPrice: number;
  stop: number | null;
  target: number | null;
  exiting: boolean;
  cost: number;
  reinvested: number;
  proceeds: number;
  dividends: number;
  commissions: number;
}

interface Order {
  view: SecurityView;
  side: "buy" | "sell";
  /** Buys: money to spend. */
  value?: number;
  /** Sells: shares to sell; undefined sells the whole position. */
  shares?: number;
  reason: FillReason;
}

const MAX_WARNINGS = 200;

function periodKey(date: string, rebalance: Strategy["rebalance"]): string {
  if (rebalance === "monthly") return date.slice(0, 7);
  if (rebalance === "quarterly") {
    return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3)}`;
  }
  // Weekly: the Monday of the date's week.
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

export function simulate(
  s: Strategy,
  data: BacktestData,
  opts: { deadline?: number } = {},
): Simulation {
  const sessions = data.sessions.filter((d) => d >= s.start && d <= s.end);
  if (sessions.length < 2) {
    throw new BacktestError("the test period has fewer than two trading sessions in the data");
  }
  const views = [...data.securities]
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.securityId.localeCompare(b.securityId))
    .map((sec) => new SecurityView(sec));
  const slip = s.costs.slippageBps / 10_000;
  const bps = s.costs.commissionBps / 10_000;
  const fixed = s.costs.commissionPerTrade;
  const maxPositions = s.sizing.maxPositions;

  let cash = s.initialCapital;
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const fills: Fill[] = [];
  const warnings: string[] = [];
  let warningsDropped = 0;
  const warn = (m: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(m);
    else warningsDropped++;
  };
  let pending: Order[] = [];

  const out: Simulation = {
    dates: sessions,
    equity: [],
    cash: [],
    exposure: [],
    positions: [],
    benchmark: [],
    trades,
    fills,
    warnings,
  };

  const lastClose = (v: SecurityView, date: string) => {
    const k = lastIndexAtOrBefore(v.data.bars.dates, date);
    return k >= 0 ? v.data.bars.close[k]! : null;
  };

  const closeTrade = (
    p: Position,
    date: string,
    price: number,
    reason: Trade["exitReason"],
    i: number,
  ) => {
    const invested = p.cost - p.reinvested;
    const pnl = p.proceeds + p.dividends - p.cost;
    trades.push({
      securityId: p.view.data.securityId,
      ticker: p.view.data.ticker,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      exitDate: reason === "open" ? null : date,
      exitPrice: reason === "open" ? null : price,
      exitReason: reason,
      invested,
      proceeds: p.proceeds,
      dividends: p.dividends,
      commissions: p.commissions,
      pnl,
      returnPct: invested > 0 ? pnl / invested : 0,
      sessionsHeld: i - p.entryIndex,
    });
  };

  const sell = (
    p: Position,
    date: string,
    i: number,
    shares: number,
    basePrice: number,
    reason: FillReason,
    costs = true,
  ) => {
    const price = costs ? basePrice * (1 - slip) : basePrice;
    const notional = shares * price;
    const commission = costs ? fixed + notional * bps : 0;
    cash += notional - commission;
    p.shares -= shares;
    p.proceeds += notional - commission;
    p.commissions += commission;
    fills.push({
      date,
      securityId: p.view.data.securityId,
      ticker: p.view.data.ticker,
      side: "sell",
      shares,
      price,
      commission,
      reason,
    });
    if (p.shares <= 1e-9) {
      p.shares = 0;
      positions.delete(p.view.data.securityId);
      closeTrade(p, date, price, reason, i);
    }
  };

  const buy = (
    view: SecurityView,
    j: number,
    date: string,
    i: number,
    value: number,
    reason: FillReason,
  ): void => {
    const free = reason === "dividend_reinvest";
    const price = view.data.bars.open[j]! * (1 + slip);
    const fee = free ? 0 : fixed;
    const rate = free ? 0 : bps;
    const budget = Math.min(value, cash);
    let shares = (budget - fee) / (price * (1 + rate));
    if (!s.fractionalShares) shares = Math.floor(shares + 1e-9);
    if (!(shares > 1e-9)) {
      if (reason !== "dividend_reinvest") {
        warn(`${view.data.ticker}: ${reason} on ${date} skipped, not enough cash for one share`);
      }
      return;
    }
    const notional = shares * price;
    const commission = fee + notional * rate;
    cash -= notional + commission;
    if (cash < 0 && cash > -1e-6) cash = 0;
    const id = view.data.securityId;
    let p = positions.get(id);
    if (!p) {
      p = {
        view,
        shares: 0,
        entryDate: date,
        entryIndex: i,
        entryPrice: price,
        stop: s.stops.stopLossPct !== null ? price * (1 - s.stops.stopLossPct) : null,
        target: s.stops.takeProfitPct !== null ? price * (1 + s.stops.takeProfitPct) : null,
        exiting: false,
        cost: 0,
        reinvested: 0,
        proceeds: 0,
        dividends: 0,
        commissions: 0,
      };
      positions.set(id, p);
    }
    p.shares += shares;
    p.cost += notional + commission;
    if (free) p.reinvested += notional;
    p.commissions += commission;
    fills.push({
      date,
      securityId: id,
      ticker: view.data.ticker,
      side: "buy",
      shares,
      price,
      commission,
      reason,
    });
  };

  // Benchmark: total return from the first session it has a close, scaled to the capital.
  const bench = data.benchmark;
  let benchBase: number | null = null;

  const holds = (r: Comparison, v: SecurityView, j: number): boolean => {
    const a = v.value(r.left, j);
    const b = v.value(r.right, j);
    if (a === null || b === null) return false;
    switch (r.op) {
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case "crosses_above":
      case "crosses_below": {
        const pa = v.value(r.left, j, 1);
        const pb = v.value(r.right, j, 1);
        if (pa === null || pb === null) return false;
        return r.op === "crosses_above" ? a > b && pa <= pb : a < b && pa >= pb;
      }
    }
  };
  const groupHolds = (g: Group, v: SecurityView, j: number): boolean => {
    const test = (r: Group["rules"][number]) =>
      "combine" in r ? groupHolds(r, v, j) : holds(r, v, j);
    return g.combine === "all" ? g.rules.every(test) : g.rules.some(test);
  };
  const member = (v: SecurityView, date: string) =>
    v.data.membership.some((m) => m.from <= date && (m.to === null || date <= m.to));

  let prev = "";
  for (let i = 0; i < sessions.length; i++) {
    const t = sessions[i]!;
    if (opts.deadline !== undefined && i % 50 === 0 && Date.now() > opts.deadline) {
      throw new BacktestError("the backtest ran past its time limit");
    }

    // 1. Splits and dividends since the previous session.
    const reinvest: Order[] = [];
    for (const p of positions.values()) {
      const d = p.view.data;
      for (const c of d.shareChanges) {
        if (c.exDate > prev && c.exDate <= t) {
          p.shares *= c.ratio;
          if (p.stop !== null) p.stop /= c.ratio;
          if (p.target !== null) p.target /= c.ratio;
        }
      }
      for (const div of d.dividends) {
        if (div.exDate > prev && div.exDate <= t) {
          const amount = p.shares * div.amount;
          cash += amount;
          p.dividends += amount;
          if (s.dividends === "reinvest") {
            reinvest.push({
              view: p.view,
              side: "buy",
              value: amount,
              reason: "dividend_reinvest",
            });
          }
        }
      }
    }

    // 2. Delistings.
    for (const p of [...positions.values()]) {
      const d = p.view.data;
      if (d.delistedAt !== null && d.delistedAt <= t && p.view.bar(t) < 0) {
        const price = lastClose(p.view, t);
        if (price !== null) sell(p, t, i, p.shares, price, "delisted", false);
      }
    }

    // 3. Orders from the previous close fill at the open.
    const carried: Order[] = [];
    for (const o of pending.filter((x) => x.side === "sell")) {
      const p = positions.get(o.view.data.securityId);
      if (!p) continue;
      const j = o.view.bar(t);
      if (j < 0) {
        carried.push(o);
        continue;
      }
      const shares = Math.min(o.shares ?? p.shares, p.shares);
      if (shares > 1e-9) sell(p, t, i, shares, o.view.data.bars.open[j]!, o.reason);
    }
    for (const o of reinvest) {
      const j = o.view.bar(t);
      if (j >= 0) buy(o.view, j, t, i, Math.min(o.value!, cash), o.reason);
    }
    for (const o of pending.filter((x) => x.side === "buy")) {
      const j = o.view.bar(t);
      if (j < 0) {
        warn(`${o.view.data.ticker}: ${o.reason} on ${t} cancelled, no trading that session`);
        continue;
      }
      buy(o.view, j, t, i, o.value!, o.reason);
    }
    pending = carried;

    // 4. Resting stop-loss and take-profit orders.
    for (const p of [...positions.values()]) {
      const j = p.view.bar(t);
      if (j < 0 || (p.stop === null && p.target === null)) continue;
      const b = p.view.data.bars;
      const open = b.open[j]!;
      if (p.stop !== null && (open <= p.stop || b.low[j]! <= p.stop)) {
        sell(p, t, i, p.shares, Math.min(open, p.stop), "stop_loss");
      } else if (p.target !== null && (open >= p.target || b.high[j]! >= p.target)) {
        sell(p, t, i, p.shares, Math.max(open, p.target), "take_profit");
      }
    }

    // 5. Mark to market.
    let held = 0;
    for (const p of positions.values()) {
      const c = lastClose(p.view, t);
      if (c !== null) held += p.shares * c;
    }
    const equity = cash + held;
    out.equity.push(equity);
    out.cash.push(cash);
    out.exposure.push(equity > 0 ? held / equity : 0);
    out.positions.push(positions.size);
    if (bench) {
      const k = lastIndexAtOrBefore(bench.dates, t);
      if (k >= 0) {
        benchBase ??= bench.adjClose[k]!;
        out.benchmark.push((s.initialCapital * bench.adjClose[k]!) / benchBase);
      } else {
        out.benchmark.push(null);
      }
    } else {
      out.benchmark.push(null);
    }

    // 6. Signals at the close, for the next session.
    const next = sessions[i + 1];
    if (next !== undefined) {
      for (const p of positions.values()) {
        if (p.exiting) continue;
        const j = p.view.bar(t);
        if (j < 0) continue;
        if (s.stops.maxHoldingDays !== null && i - p.entryIndex >= s.stops.maxHoldingDays) {
          p.exiting = true;
          pending.push({ view: p.view, side: "sell", reason: "max_hold" });
        } else if (s.exit && groupHolds(s.exit, p.view, j)) {
          p.exiting = true;
          pending.push({ view: p.view, side: "sell", reason: "exit_rule" });
        }
      }
      const staying = [...positions.values()].filter((p) => !p.exiting).length;
      let free = maxPositions - staying;
      const target = equity / maxPositions;
      if (free > 0) {
        const candidates: { view: SecurityView; rank: number | null }[] = [];
        for (const v of views) {
          if (positions.has(v.data.securityId)) continue;
          if (!member(v, t)) continue;
          const j = v.bar(t);
          if (j < 0) continue;
          if (!groupHolds(s.entry, v, j)) continue;
          candidates.push({ view: v, rank: s.rank ? v.value(s.rank.by, j) : null });
        }
        if (s.rank) {
          const dir = s.rank.order === "asc" ? 1 : -1;
          candidates.sort((a, b) => {
            if (a.rank === null || b.rank === null) {
              return a.rank === b.rank ? 0 : a.rank === null ? 1 : -1;
            }
            return (a.rank - b.rank) * dir;
          });
        }
        for (const c of candidates) {
          if (free <= 0) break;
          pending.push({ view: c.view, side: "buy", value: target, reason: "entry" });
          free--;
        }
      }
      if (s.rebalance !== "none" && periodKey(t, s.rebalance) !== periodKey(next, s.rebalance)) {
        for (const p of positions.values()) {
          if (p.exiting) continue;
          const j = p.view.bar(t);
          if (j < 0) continue;
          const close = p.view.data.bars.close[j]!;
          const diff = target - p.shares * close;
          // Ignore drift under 1% of the target or a single share.
          if (Math.abs(diff) < Math.max(target * 0.01, close)) continue;
          if (diff > 0) {
            pending.push({ view: p.view, side: "buy", value: diff, reason: "rebalance" });
          } else {
            const raw = -diff / close;
            const shares = s.fractionalShares ? raw : Math.floor(raw);
            if (shares > 0) {
              pending.push({ view: p.view, side: "sell", shares, reason: "rebalance" });
            }
          }
        }
      }
    }
    prev = t;
  }

  // Positions still open at the end are reported at their last close.
  const end = sessions[sessions.length - 1]!;
  for (const p of positions.values()) {
    const c = lastClose(p.view, end) ?? 0;
    const value = p.shares * c;
    const invested = p.cost - p.reinvested;
    const proceeds = p.proceeds + value;
    const pnl = proceeds + p.dividends - p.cost;
    trades.push({
      securityId: p.view.data.securityId,
      ticker: p.view.data.ticker,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      exitDate: null,
      exitPrice: null,
      exitReason: "open",
      invested,
      proceeds,
      dividends: p.dividends,
      commissions: p.commissions,
      pnl,
      returnPct: invested > 0 ? pnl / invested : 0,
      sessionsHeld: sessions.length - 1 - p.entryIndex,
    });
  }
  trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.ticker.localeCompare(b.ticker));
  if (warningsDropped > 0) warnings.push(`…and ${warningsDropped} more warnings`);
  return out;
}
