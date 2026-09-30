import {
  isTradingDay,
  latestClosedSession,
  tradingDaysBetween,
  addDays,
  type IsoDate,
} from "@market/calendar";
import { ProviderError } from "../errors";
import { BaseProvider, type SymbolRange } from "../provider";
import type {
  AssetClass,
  CorporateAction,
  CorporateActionType,
  DailyBar,
  SecurityRecord,
  SymbolPeriod,
} from "../types";
import { sessionCloseOf } from "./common";

/**
 * Deterministic synthetic market data for development and tests (spec rule 6). Every ticker is
 * prefixed TEST_, every record is `source = "synthetic"` with license tier `synthetic`, and the
 * env config refuses this provider in production.
 *
 * The universe (default 500 securities from 2016-01-04) mixes plain random-walk securities with
 * a catalogue of scenarios the pipeline must handle: splits, a reverse split, cash/special/stock
 * dividends, a delisting, a reused ticker, a symbol change, an IPO, a halt gap, a spin-off, a
 * >50% jump with no action, and bad bars (inconsistent OHLC, negative volume, conflicting
 * duplicate). The same seed always yields the same data; bars never extend past the latest
 * closed session at `now()`.
 */

export const SYNTHETIC_UNIVERSE_START: IsoDate = "2016-01-04";
export const SYNTHETIC_BACKFILL_END: IsoDate = "2025-12-31";

type ActionPlan =
  | { type: "split" | "stock_dividend"; ex_date: IsoDate; ratio: number }
  | { type: "cash_dividend" | "special_dividend"; ex_date: IsoDate; yield: number }
  | {
      type: "spin_off" | "symbol_change" | "merger";
      ex_date: IsoDate;
      details: Record<string, unknown>;
    };

interface Anomalies {
  jump?: IsoDate;
  badBar?: IsoDate;
  negativeVolume?: IsoDate;
  halt?: [IsoDate, IsoDate];
  conflictingDuplicate?: IsoDate;
}

export interface SyntheticSecuritySpec {
  key: string;
  ticker: string;
  vendorSymbol: string;
  name: string;
  assetClass: AssetClass;
  exchangeMic: string;
  sector: string;
  /** First trading day. */
  listed: IsoDate;
  /** First day it no longer trades (exclusive); null while listed. */
  delisted: IsoDate | null;
  history: SymbolPeriod[];
  plans: ActionPlan[];
  anomalies: Anomalies;
}

const SECTORS = [
  "Technology",
  "Health Care",
  "Financials",
  "Industrials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Materials",
  "Real Estate",
  "Communication Services",
];

/** First trading day on or after the 15th of each Feb/May/Aug/Nov within [from, to). */
function quarterlyExDates(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    for (const month of [2, 5, 8, 11]) {
      let d = `${year}-${String(month).padStart(2, "0")}-15`;
      while (!isTradingDay(d)) d = addDays(d, 1);
      if (d > from && d < to) out.push(d);
    }
  }
  return out;
}

const QUARTERLY_END = "2030-12-31";
const quarterly = (from: IsoDate, yieldPerQuarter: number, to = QUARTERLY_END): ActionPlan[] =>
  quarterlyExDates(from, to).map((ex_date) => ({
    type: "cash_dividend",
    ex_date,
    yield: yieldPerQuarter,
  }));

function spec(
  partial: Partial<SyntheticSecuritySpec> & { key: string; ticker: string },
): SyntheticSecuritySpec {
  const listed = partial.listed ?? SYNTHETIC_UNIVERSE_START;
  const delisted = partial.delisted ?? null;
  return {
    vendorSymbol: partial.ticker,
    name: `${partial.ticker} Synthetic Corp`,
    assetClass: "equity",
    exchangeMic: "XNYS",
    sector: "Technology",
    listed,
    delisted,
    history: [{ ticker: partial.ticker, valid_from: listed, valid_to: delisted }],
    plans: [],
    anomalies: {},
    ...partial,
  };
}

/** The scenario catalogue, then plain securities up to `size`. */
export function syntheticUniverse(size = 500): SyntheticSecuritySpec[] {
  const s = SYNTHETIC_UNIVERSE_START;
  const scenarios: SyntheticSecuritySpec[] = [
    spec({
      key: "SYN-SPLIT4",
      ticker: "TEST_SPLIT4",
      plans: [{ type: "split", ex_date: "2020-08-31", ratio: 4 }],
    }),
    spec({
      key: "SYN-SPLIT20",
      ticker: "TEST_SPLIT20",
      plans: [{ type: "split", ex_date: "2022-07-18", ratio: 20 }],
    }),
    spec({
      key: "SYN-RSPLIT",
      ticker: "TEST_RSPLIT",
      plans: [{ type: "split", ex_date: "2023-05-15", ratio: 0.1 }],
    }),
    spec({ key: "SYN-DIV", ticker: "TEST_DIV", sector: "Utilities", plans: quarterly(s, 0.006) }),
    spec({
      key: "SYN-SPECIAL",
      ticker: "TEST_SPECIAL",
      sector: "Financials",
      plans: [
        ...quarterly(s, 0.005),
        { type: "special_dividend", ex_date: "2021-12-15", yield: 0.08 },
      ],
    }),
    spec({
      key: "SYN-STKDIV",
      ticker: "TEST_STKDIV",
      plans: [{ type: "stock_dividend", ex_date: "2019-06-17", ratio: 1.05 }],
    }),
    spec({ key: "SYN-DELIST", ticker: "TEST_DELIST", delisted: "2021-03-31" }),
    spec({
      key: "SYN-REUSE-A",
      ticker: "TEST_REUSE",
      name: "TEST_REUSE First Holder Corp",
      delisted: "2019-07-01",
    }),
    spec({
      key: "SYN-REUSE-B",
      ticker: "TEST_REUSE",
      name: "TEST_REUSE Second Holder Corp",
      listed: "2020-01-02",
    }),
    spec({
      key: "SYN-RENAME",
      ticker: "TEST_NEWNM",
      name: "TEST_NEWNM Synthetic Corp (formerly TEST_OLDNM)",
      history: [
        { ticker: "TEST_OLDNM", valid_from: s, valid_to: "2022-01-03" },
        { ticker: "TEST_NEWNM", valid_from: "2022-01-03", valid_to: null },
      ],
      plans: [
        {
          type: "symbol_change",
          ex_date: "2022-01-03",
          details: { old_ticker: "TEST_OLDNM", new_ticker: "TEST_NEWNM" },
        },
      ],
    }),
    spec({ key: "SYN-JUMP", ticker: "TEST_JUMP", anomalies: { jump: "2020-03-16" } }),
    spec({ key: "SYN-BADBAR", ticker: "TEST_BADBAR", anomalies: { badBar: "2019-10-10" } }),
    spec({ key: "SYN-NEGVOL", ticker: "TEST_NEGVOL", anomalies: { negativeVolume: "2019-10-11" } }),
    spec({
      key: "SYN-HALT",
      ticker: "TEST_HALT",
      anomalies: { halt: ["2018-05-07", "2018-05-09"] },
    }),
    spec({ key: "SYN-IPO", ticker: "TEST_IPO", listed: "2021-06-15", exchangeMic: "XNAS" }),
    spec({ key: "SYN-DUP", ticker: "TEST_DUP", anomalies: { conflictingDuplicate: "2024-02-01" } }),
    spec({
      key: "SYN-SPINOFF",
      ticker: "TEST_SPINOFF",
      plans: [
        {
          type: "spin_off",
          ex_date: "2022-11-01",
          details: { distributed_ticker: "TEST_SPUN", shares_per_share: 0.25 },
        },
      ],
    }),
  ];

  const out = [...scenarios];
  for (let i = 1; out.length < size; i += 1) {
    const ticker = `TEST_S${String(i).padStart(3, "0")}`;
    out.push(
      spec({
        key: `SYN-S${String(i).padStart(3, "0")}`,
        ticker,
        assetClass: i % 25 === 0 ? "etf" : "equity",
        exchangeMic: i % 2 === 0 ? "XNAS" : "XNYS",
        sector: SECTORS[i % SECTORS.length]!,
        plans: i % 5 === 0 ? quarterly(s, 0.004 + (i % 4) * 0.001) : [],
      }),
    );
  }
  return out.slice(0, size);
}

// --- Deterministic randomness ---------------------------------------------------------------

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function roundPrice(p: number): number {
  const decimals = p >= 1 ? 2 : 4;
  const f = 10 ** decimals;
  return Math.max(Math.round(p * f) / f, 0.0001);
}

// --- Generation -----------------------------------------------------------------------------

interface RawBar {
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RealizedAction {
  type: CorporateActionType;
  ex_date: IsoDate;
  ratio: number | null;
  cash_amount: number | null;
  details: Record<string, unknown>;
}

interface Series {
  until: IsoDate;
  bars: RawBar[];
  actions: RealizedAction[];
}

function generate(spec: SyntheticSecuritySpec, seed: number, until: IsoDate): Series {
  const rng = mulberry32(fnv1a(`${seed}:${spec.key}`));
  const sigma = 0.01 + rng() * 0.02;
  const mu = (rng() - 0.45) * 0.001;
  let price = roundPrice(10 + rng() * 290);
  const baseVolume = 200_000 + rng() * 5_000_000;
  let shareScale = 1;

  const lastDay =
    spec.delisted && addDays(spec.delisted, -1) < until ? addDays(spec.delisted, -1) : until;
  const days = spec.listed <= lastDay ? tradingDaysBetween(spec.listed, lastDay) : [];
  const plansByDate = new Map<IsoDate, ActionPlan[]>();
  for (const p of spec.plans)
    plansByDate.set(p.ex_date, [...(plansByDate.get(p.ex_date) ?? []), p]);

  const bars: RawBar[] = [];
  const actions: RealizedAction[] = [];
  const a = spec.anomalies;
  for (const date of days) {
    if (a.halt && date >= a.halt[0] && date <= a.halt[1]) continue;

    for (const plan of plansByDate.get(date) ?? []) {
      if ("ratio" in plan) {
        price /= plan.ratio;
        shareScale *= plan.ratio;
        actions.push({
          type: plan.type,
          ex_date: date,
          ratio: plan.ratio,
          cash_amount: null,
          details: {},
        });
      } else if ("yield" in plan) {
        const amount = Math.max(0.01, Math.round(price * plan.yield * 100) / 100);
        price -= amount;
        actions.push({
          type: plan.type,
          ex_date: date,
          ratio: null,
          cash_amount: amount,
          details: {},
        });
      } else {
        actions.push({
          type: plan.type,
          ex_date: date,
          ratio: null,
          cash_amount: null,
          details: plan.details,
        });
      }
    }

    const move = mu + sigma * normal(rng) + (a.jump === date ? Math.log(1.6) : 0);
    const open = roundPrice(price * Math.exp((sigma / 3) * normal(rng)));
    const close = roundPrice(Math.max(price * Math.exp(move), 0.05));
    const highExt = Math.min(0.5, Math.abs(normal(rng)) * (sigma / 2));
    const lowExt = Math.min(0.5, Math.abs(normal(rng)) * (sigma / 2));
    const bar: RawBar = {
      date,
      open,
      high: roundPrice(Math.max(open, close) * (1 + highExt)),
      low: roundPrice(Math.min(open, close) * (1 - lowExt)),
      close,
      volume: Math.round(baseVolume * shareScale * Math.exp(0.4 * normal(rng))),
    };
    price = close;

    if (a.badBar === date) bar.high = roundPrice(bar.close * 0.98);
    if (a.negativeVolume === date) bar.volume = -100;
    bars.push(bar);
    if (a.conflictingDuplicate === date) {
      const close2 = roundPrice(bar.close * 1.01);
      bars.push({ ...bar, close: close2, high: Math.max(bar.high, close2) });
    }
  }
  return { until, bars, actions };
}

// --- Provider -------------------------------------------------------------------------------

export interface SyntheticOptions {
  seed?: number;
  universeSize?: number;
  now?: () => Date;
}

export class SyntheticProvider extends BaseProvider {
  readonly id = "synthetic" as const;
  readonly universe: readonly SyntheticSecuritySpec[];
  private readonly seed: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, Series>();
  private outage: Error | null = null;

  constructor(opts: SyntheticOptions = {}) {
    super();
    this.seed = opts.seed ?? 20_260_930;
    this.now = opts.now ?? (() => new Date());
    this.universe = syntheticUniverse(opts.universeSize ?? 500);
  }

  /** Makes every call fail until cleared (for failover and staleness tests and demos). */
  simulateOutage(
    error: Error | null = new ProviderError("synthetic", "Simulated outage", {
      status: 503,
      retryable: true,
    }),
  ): void {
    this.outage = error;
  }

  /** Runs `fn` as a promise, rejecting instead of throwing (including during an outage). */
  private run<T>(fn: () => T): Promise<T> {
    try {
      if (this.outage) throw this.outage;
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private series(spec: SyntheticSecuritySpec, until: IsoDate): Series {
    const cached = this.cache.get(spec.key);
    if (cached && cached.until >= until) return cached;
    const fresh = generate(spec, this.seed, until);
    this.cache.set(spec.key, fresh);
    return fresh;
  }

  private horizon(end: IsoDate): IsoDate {
    const latest = latestClosedSession(this.now()).date;
    return end < latest ? end : latest;
  }

  private specsFor(symbol: string): SyntheticSecuritySpec[] {
    return this.universe.filter((s) => s.vendorSymbol === symbol);
  }

  override getSecurities(req: { symbols?: readonly string[] } = {}): Promise<SecurityRecord[]> {
    return this.run(() => {
      const fetchedAt = this.now();
      const wanted = req.symbols ? new Set(req.symbols) : null;
      return this.universe
        .filter((s) => !wanted || wanted.has(s.vendorSymbol))
        .map((s) => ({
          source: this.id,
          source_symbol: s.vendorSymbol,
          fetched_at: fetchedAt,
          as_of: fetchedAt,
          license_tier: "synthetic" as const,
          source_security_id: s.key,
          ticker: s.ticker,
          name: s.name,
          asset_class: s.assetClass,
          exchange_mic: s.exchangeMic,
          cik: null,
          figi: null,
          sector: s.sector,
          industry: null,
          currency: "USD",
          listed_at: s.listed,
          delisted_at: s.delisted,
          symbol_history: s.history,
        }));
    });
  }

  override getDailyBars(req: SymbolRange): Promise<DailyBar[]> {
    return this.run(() => this.bars(req));
  }

  private bars(req: SymbolRange): DailyBar[] {
    const fetchedAt = this.now();
    const end = this.horizon(req.end);
    const out: DailyBar[] = [];
    for (const spec of this.specsFor(req.symbol)) {
      for (const b of this.series(spec, end).bars) {
        if (b.date < req.start || b.date > end) continue;
        out.push({
          source: this.id,
          source_symbol: req.symbol,
          fetched_at: fetchedAt,
          as_of: sessionCloseOf(b.date),
          license_tier: "synthetic",
          ...b,
          vwap: null,
        });
      }
    }
    return out;
  }

  override getCorporateActions(req: SymbolRange): Promise<CorporateAction[]> {
    return this.run(() => this.actions(req));
  }

  private actions(req: SymbolRange): CorporateAction[] {
    const fetchedAt = this.now();
    const end = this.horizon(req.end);
    const out: CorporateAction[] = [];
    for (const spec of this.specsFor(req.symbol)) {
      for (const a of this.series(spec, end).actions) {
        if (a.ex_date < req.start || a.ex_date > end) continue;
        out.push({
          source: this.id,
          source_symbol: req.symbol,
          fetched_at: fetchedAt,
          as_of: sessionCloseOf(a.ex_date),
          license_tier: "synthetic",
          type: a.type,
          ex_date: a.ex_date,
          ratio: a.ratio,
          cash_amount: a.cash_amount,
          currency: a.cash_amount === null ? null : "USD",
          record_date: null,
          pay_date: null,
          details: a.details,
        });
      }
    }
    return out;
  }

  override healthCheck(): Promise<void> {
    return this.run(() => undefined);
  }
}
