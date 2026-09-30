import { SECTORS } from "@market/market-data";
import { sql } from "@market/db";
import { createTestDatabase, type TestDatabase } from "@market/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateScreen,
  FIELD_IDS,
  fieldDef,
  parseScreen,
  PRESETS,
  runScreen,
  type FieldId,
  type Screen,
  type SnapshotRow,
} from "../src";
import { TEMPLATE } from "./global-setup";

/**
 * The SQL compiler against the in-memory oracle on random data and random screens (step F2),
 * and the latency budget at 6,000 securities (step F4: p95 under 1 s).
 */
let t: TestDatabase;
const ROWS: SnapshotRow[] = [];

// Deterministic pseudo-random numbers (mulberry32).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260930);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const maybe = (v: number, pNull = 0.1) => (rand() < pNull ? null : v);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function randomRow(i: number): SnapshotRow {
  const close = round(1 + rand() * 500, 2);
  const high = close * (1 + rand() * 0.5);
  return {
    security_id: i + 1,
    ticker: `TEST_S${String(i).padStart(4, "0")}`,
    name: `TEST_S${String(i).padStart(4, "0")} Synthetic Corp`,
    asset_class: rand() < 0.9 ? "equity" : "etf",
    sector: rand() < 0.05 ? null : pick(SECTORS),
    close,
    change_1d: maybe((rand() - 0.5) * 0.2),
    return_1w: maybe((rand() - 0.5) * 0.3),
    return_1m: maybe((rand() - 0.5) * 0.5),
    return_3m: maybe((rand() - 0.5) * 0.8),
    return_6m: maybe((rand() - 0.4) * 1.2),
    return_ytd: maybe((rand() - 0.4) * 1.2),
    return_1y: maybe((rand() - 0.4) * 2),
    sma50: maybe(close * (0.8 + rand() * 0.4)),
    sma200: maybe(close * (0.7 + rand() * 0.6), 0.15),
    rsi14: maybe(rand() * 100),
    high_52w: maybe(high),
    low_52w: maybe(close * (0.5 + rand() * 0.5)),
    avg_volume_30d: maybe(1e4 + rand() * 5e7),
    market_cap: maybe(1e8 + rand() * 3e12, 0.2),
    pe: maybe(rand() * 80, 0.3),
    ps: maybe(rand() * 30, 0.3),
    pb: maybe(rand() * 20, 0.3),
    dividend_yield: maybe(rand() * 0.08, 0.4),
  };
}

const NUMERIC = FIELD_IDS.filter((f) => fieldDef(f).type === "number");

function randomValue(field: FieldId): number {
  // Draw a threshold from the data itself so conditions select something.
  const values = ROWS.map((r) => r[field]).filter((v): v is number => typeof v === "number");
  if (fieldDef(field).computed) return (rand() - 0.5) * 0.6;
  return values.length ? pick(values) * (0.9 + rand() * 0.2) : rand();
}

function randomScreen(): Screen {
  const n = 1 + Math.floor(rand() * 3);
  const conditions = [];
  for (let i = 0; i < n; i += 1) {
    const kind = rand();
    if (kind < 0.12) {
      conditions.push({ field: "sector", op: "in", value: [pick(SECTORS), pick(SECTORS)] });
    } else if (kind < 0.2) {
      conditions.push({ field: pick(NUMERIC), op: pick(["is_null", "not_null"] as const) });
    } else if (kind < 0.35) {
      conditions.push({
        field: pick(NUMERIC),
        op: pick(["gt", "lt"] as const),
        ref: pick(NUMERIC),
      });
    } else if (kind < 0.45) {
      const f = pick(NUMERIC);
      const a = randomValue(f);
      const b = randomValue(f);
      conditions.push({ field: f, op: "between", value: [Math.min(a, b), Math.max(a, b)] });
    } else {
      const f = pick(NUMERIC);
      conditions.push({
        field: f,
        op: pick(["gt", "gte", "lt", "lte"] as const),
        value: randomValue(f),
      });
    }
  }
  return parseScreen({
    conditions,
    sort: { field: pick([...NUMERIC, "ticker"] as FieldId[]), dir: pick(["asc", "desc"] as const) },
  });
}

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
  for (let i = 0; i < 6000; i += 1) ROWS.push(randomRow(i));
  await sql`insert into market.data_providers (provider_id, display_name, kind)
            values ('synthetic', 'Synthetic', 'synthetic') on conflict do nothing`.execute(t.db);
  for (let i = 0; i < ROWS.length; i += 1000) {
    const chunk = ROWS.slice(i, i + 1000);
    await t.db
      .insertInto("market.securities")
      .values(
        chunk.map((r) => ({
          ticker: String(r.ticker),
          name: String(r.name),
          asset_class: String(r.asset_class),
        })),
      )
      .execute();
  }
  const ids = await t.db
    .selectFrom("market.securities")
    .select(["security_id", "ticker"])
    .execute();
  const idOf = new Map(ids.map((r) => [r.ticker, r.security_id]));
  for (let i = 0; i < ROWS.length; i += 500) {
    await t.db
      .insertInto("market.screener_snapshot")
      .values(
        ROWS.slice(i, i + 500).map((r) => {
          const { security_id: _, ...rest } = r;
          return {
            ...rest,
            security_id: idOf.get(String(r.ticker))!,
            source: "synthetic",
            as_of: "2026-09-29",
          } as never;
        }),
      )
      .execute();
  }
  await sql`analyze market.screener_snapshot`.execute(t.db);
});
afterAll(async () => {
  await t.drop();
});

describe("SQL compiler vs oracle", () => {
  it("agrees on 300 random screens, including order and totals", async () => {
    for (let i = 0; i < 300; i += 1) {
      const screen = randomScreen();
      const expected = evaluateScreen(ROWS, screen);
      const { rows, total } = await runScreen(t.db, screen, { limit: 100, offset: 0 });
      expect(total, JSON.stringify(screen)).toBe(expected.length);
      expect(
        rows.map((r) => r.ticker),
        JSON.stringify(screen),
      ).toEqual(expected.slice(0, 100).map((r) => r.ticker));
    }
  });

  it("agrees on every preset", async () => {
    for (const p of PRESETS) {
      const expected = evaluateScreen(ROWS, p.screen);
      const { total, rows } = await runScreen(t.db, p.screen, { limit: 50, offset: 0 });
      expect(total, p.id).toBe(expected.length);
      expect(
        rows.map((r) => r.ticker),
        p.id,
      ).toEqual(expected.slice(0, 50).map((r) => r.ticker));
    }
  });

  it("pages through results", async () => {
    const screen = parseScreen({ sort: { field: "ticker", dir: "asc" } });
    const page2 = await runScreen(t.db, screen, { limit: 50, offset: 50 });
    expect(page2.total).toBe(6000);
    expect(page2.rows[0]?.ticker).toBe("TEST_S0050");
  });
});

describe("latency at 6,000 securities", () => {
  it("keeps p95 under 1 s across presets and random screens", async () => {
    const screens = [...PRESETS.map((p) => p.screen), ...Array.from({ length: 40 }, randomScreen)];
    const times: number[] = [];
    for (const screen of screens) {
      const started = performance.now();
      await runScreen(t.db, screen, { limit: 50, offset: 0 });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.info(
      `screener at 6,000 securities: p95 ${p95.toFixed(1)} ms over ${times.length} screens`,
    );
    expect(p95).toBeLessThan(1000);
  });
});
