import { annualize, daysBetween, maxDrawdown, xirr, type CashFlow } from "./returns";
import type { DayValue, Lot, PortfolioReport, Position, PriceBook, ShareAction, Tx } from "./types";

const EPS = 1e-9;

/** The latest close on or before `date`, or null. */
export function closeOn(
  prices: PriceBook,
  securityId: string,
  date: string,
): { close: number; date: string } | null {
  const series = prices.get(securityId);
  if (!series || series.dates.length === 0) return null;
  let lo = 0;
  let hi = series.dates.length - 1;
  if (series.dates[0]! > date) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series.dates[mid]! <= date) lo = mid;
    else hi = mid - 1;
  }
  return { close: series.closes[lo]!, date: series.dates[lo]! };
}

function sortedTxs(txs: readonly Tx[]): Tx[] {
  return txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => (a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : a.i - b.i))
    .map((x) => x.tx);
}

/**
 * Replays the ledger day by day (Phase 1 step J): FIFO lots adjusted for splits and stock
 * dividends, cash, and a valuation at each date's close.
 *
 * Conventions (also in docs/DECISIONS.md, ADR-023):
 * - Days are the union of `calendar` (trading days), transaction dates and `end`, from the
 *   first transaction to `end`. A security with no close that day is valued at its latest
 *   earlier close, or at cost when it has none (with a warning).
 * - A split applies to lots opened before its ex-date, at the first day on or after it,
 *   before that day's transactions.
 * - Cash never goes negative: a shortfall at the end of a day is an implicit deposit, so a
 *   ledger of buys alone still has correct returns.
 * - External flows (deposits, implicit deposits, withdrawals) count at the start of the day:
 *   r = value / (previous value + flow) − 1. Dividends and fees are returns, not flows.
 */
export function analyzePortfolio(
  txs: readonly Tx[],
  actions: readonly ShareAction[],
  prices: PriceBook,
  opts: { end: string; calendar?: readonly string[] },
): PortfolioReport {
  const ledger = sortedTxs(txs).filter((t) => t.date <= opts.end);
  const empty: PortfolioReport = {
    start: null,
    end: opts.end,
    days: [],
    positions: [],
    cash: 0,
    value: 0,
    netContributions: 0,
    twr: null,
    twrAnnualized: null,
    xirr: null,
    maxDrawdown: null,
    realized: 0,
    unrealized: 0,
    dividends: 0,
    fees: 0,
    warnings: [],
  };
  if (ledger.length === 0) return empty;
  const start = ledger[0]!.date;

  const held = new Set(ledger.flatMap((t) => (t.securityId ? [t.securityId] : [])));
  const calendar = opts.calendar ?? [...held].flatMap((id) => [...(prices.get(id)?.dates ?? [])]);
  const dates = [
    ...new Set(
      [...calendar, ...ledger.map((t) => t.date), opts.end].filter(
        (d) => d >= start && d <= opts.end,
      ),
    ),
  ].sort();

  const pendingActions = actions
    .filter(
      (a) => held.has(a.securityId) && a.ratio > 0 && a.exDate > start && a.exDate <= opts.end,
    )
    .sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0));
  const lots = new Map<string, Lot[]>();
  const warnings = new Set<string>();
  let cash = 0;
  let realized = 0;
  let dividends = 0;
  let fees = 0;
  let netContributions = 0;
  let prevValue = 0;
  let index = 1;
  let ai = 0;
  let ti = 0;
  const days: DayValue[] = [];
  const flows: CashFlow[] = [];

  for (const date of dates) {
    // Splits effective on or before today, before today's trades.
    while (ai < pendingActions.length && pendingActions[ai]!.exDate <= date) {
      const a = pendingActions[ai++]!;
      for (const lot of lots.get(a.securityId) ?? []) {
        if (lot.openDate < a.exDate) {
          lot.quantity *= a.ratio;
          lot.costPerShare /= a.ratio;
        }
      }
    }

    let flow = 0;
    while (ti < ledger.length && ledger[ti]!.date === date) {
      const t = ledger[ti++]!;
      const txFees = t.fees || 0;
      switch (t.type) {
        case "buy": {
          const q = t.quantity ?? 0;
          const cost = q * (t.price ?? 0) + txFees;
          cash -= cost;
          fees += txFees;
          if (q > 0 && t.securityId) {
            const list = lots.get(t.securityId) ?? [];
            list.push({
              securityId: t.securityId,
              openDate: date,
              quantity: q,
              costPerShare: cost / q,
            });
            lots.set(t.securityId, list);
          }
          break;
        }
        case "sell": {
          const list = (t.securityId && lots.get(t.securityId)) || [];
          const available = list.reduce((s, l) => s + l.quantity, 0);
          let q = t.quantity ?? 0;
          if (q > available + EPS) {
            warnings.add(`${date}: sells ${q} but only ${available} held; sold what was held`);
            q = available;
          }
          let remaining = q;
          let costOut = 0;
          while (remaining > EPS && list.length > 0) {
            const lot = list[0]!;
            const take = Math.min(lot.quantity, remaining);
            costOut += take * lot.costPerShare;
            lot.quantity -= take;
            remaining -= take;
            if (lot.quantity <= EPS) list.shift();
          }
          const proceeds = q * (t.price ?? 0) - txFees;
          cash += proceeds;
          fees += txFees;
          realized += proceeds - costOut;
          break;
        }
        case "dividend":
          cash += (t.amount ?? 0) - txFees;
          dividends += t.amount ?? 0;
          fees += txFees;
          break;
        case "deposit":
          cash += t.amount ?? 0;
          flow += t.amount ?? 0;
          break;
        case "withdrawal":
          cash -= t.amount ?? 0;
          flow -= t.amount ?? 0;
          break;
        case "fee":
          cash -= t.amount ?? 0;
          fees += t.amount ?? 0;
          break;
      }
    }

    let implicitDeposit = 0;
    if (cash < -EPS) {
      implicitDeposit = -cash;
      cash = 0;
      flow += implicitDeposit;
    }

    let holdings = 0;
    for (const [securityId, list] of lots) {
      const qty = list.reduce((s, l) => s + l.quantity, 0);
      if (qty <= EPS) continue;
      const px = closeOn(prices, securityId, date);
      if (px) holdings += qty * px.close;
      else {
        holdings += list.reduce((s, l) => s + l.quantity * l.costPerShare, 0);
        warnings.add(`no price for security ${securityId} on ${date}; valued at cost`);
      }
    }
    const value = cash + holdings;
    const base = prevValue + flow;
    const dailyReturn = base > EPS ? value / base - 1 : 0;
    index *= 1 + dailyReturn;
    netContributions += flow;
    if (flow !== 0) flows.push({ date, amount: -flow });
    days.push({ date, cash, holdings, value, flow, implicitDeposit, dailyReturn, index });
    prevValue = value;
  }

  const last = days.at(-1)!;
  const positions: Position[] = [];
  for (const [securityId, list] of lots) {
    const quantity = list.reduce((s, l) => s + l.quantity, 0);
    if (quantity <= EPS) continue;
    const costBasis = list.reduce((s, l) => s + l.quantity * l.costPerShare, 0);
    const px = closeOn(prices, securityId, opts.end);
    const marketValue = px ? quantity * px.close : costBasis;
    positions.push({
      securityId,
      quantity,
      costBasis,
      price: px?.close ?? null,
      priceDate: px?.date ?? null,
      marketValue,
      unrealized: marketValue - costBasis,
      weight: last.value > 0 ? marketValue / last.value : 0,
    });
  }
  positions.sort((a, b) => b.marketValue - a.marketValue);

  const twr = index - 1;
  return {
    start,
    end: opts.end,
    days,
    positions,
    cash: last.cash,
    value: last.value,
    netContributions,
    twr,
    twrAnnualized: annualize(twr, daysBetween(start, opts.end)),
    xirr: xirr([...flows, { date: opts.end, amount: last.value }]),
    maxDrawdown: maxDrawdown(days.map((d) => d.index)),
    realized,
    unrealized: positions.reduce((s, p) => s + p.unrealized, 0),
    dividends,
    fees,
    warnings: [...warnings],
  };
}

/**
 * Sells that exceed the shares held at the time (after splits), as indexes into `txs`. Used to
 * reject an import before anything is stored.
 */
export function oversoldSells(
  txs: readonly Tx[],
  actions: readonly ShareAction[],
): { index: number; held: number }[] {
  const order = txs
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => (a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : a.index - b.index));
  const sortedActions = [...actions].sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const qty = new Map<string, number>();
  let ai = 0;
  const out: { index: number; held: number }[] = [];
  for (const { tx, index } of order) {
    while (ai < sortedActions.length && sortedActions[ai]!.exDate <= tx.date) {
      const a = sortedActions[ai++]!;
      const q = qty.get(a.securityId);
      if (q !== undefined) qty.set(a.securityId, q * a.ratio);
    }
    if (!tx.securityId || tx.quantity === null) continue;
    const q = qty.get(tx.securityId) ?? 0;
    if (tx.type === "buy") qty.set(tx.securityId, q + tx.quantity);
    if (tx.type === "sell") {
      if (tx.quantity > q + EPS) out.push({ index, held: q });
      qty.set(tx.securityId, Math.max(0, q - tx.quantity));
    }
  }
  return out;
}
