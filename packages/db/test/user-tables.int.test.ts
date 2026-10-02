import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, withRole, type TestDatabase } from "../src/testing";
import { TEMPLATE } from "./global-setup";

/**
 * Row-level security on the per-user tables (migrations 10 and 13 to 16): a signed-in user sees
 * and changes only their own rows; anonymous clients see nothing; the audit log and backtest
 * results are read-only to clients.
 */
const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";

let t: TestDatabase;
let securityId: string;
const runIds = new Map<string, string>();

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
  const s = await t.pool.query<{ security_id: string }>(
    `insert into market.securities (ticker, name, asset_class) values ('TEST_RLS', 'RLS', 'equity')
     returning security_id`,
  );
  securityId = s.rows[0]!.security_id;
  // Rows for both users, written by the server (table owner, as the local app does).
  for (const user of [ALICE, BOB]) {
    const w = await t.pool.query<{ watchlist_id: string }>(
      `insert into public.watchlists (user_id, name) values ($1, 'Main') returning watchlist_id`,
      [user],
    );
    await t.pool.query(
      `insert into public.watchlist_items (watchlist_id, user_id, security_id) values ($1, $2, $3)`,
      [w.rows[0]!.watchlist_id, user, securityId],
    );
    await t.pool.query(
      `insert into public.saved_screens (user_id, name, definition) values ($1, 'Cheap', '{}')`,
      [user],
    );
    await t.pool.query(`insert into public.audit_logs (user_id, action) values ($1, 'login')`, [
      user,
    ]);
    const st = await t.pool.query<{ strategy_id: string }>(
      `insert into public.strategies (user_id, name, definition) values ($1, 'Trend', '{}')
       returning strategy_id`,
      [user],
    );
    const run = await t.pool.query<{ run_id: string }>(
      `insert into public.backtest_runs (user_id, strategy_id, name, kind, request)
       values ($1, $2, 'Trend', 'single', '{}') returning run_id`,
      [user, st.rows[0]!.strategy_id],
    );
    runIds.set(user, run.rows[0]!.run_id);
    await t.pool.query(
      `insert into public.valuation_scenarios (user_id, security_id, name, inputs)
       values ($1, $2, 'Base case', '{}')`,
      [user, securityId],
    );
    await t.pool.query(
      `insert into public.backtest_results (run_id, user_id, summary, report, inputs)
       values ($1, $2, '{}', '{}', '{}')`,
      [run.rows[0]!.run_id, user],
    );
    const alert = await t.pool.query<{ alert_id: string }>(
      `insert into public.alerts (user_id, security_id, kind, params)
       values ($1, $2, 'price_above', '{"price": 1}') returning alert_id`,
      [user, securityId],
    );
    const event = await t.pool.query<{ event_id: string }>(
      `insert into public.alert_events (alert_id, user_id, bar_date, event_key, message)
       values ($1, $2, '2026-09-30', '2026-09-30', 'Fired') returning event_id`,
      [alert.rows[0]!.alert_id, user],
    );
    await t.pool.query(
      `insert into public.notifications (user_id, event_id, title, href)
       values ($1, $2, 'Fired', '/stocks/TEST_RLS')`,
      [user, event.rows[0]!.event_id],
    );
    await t.pool.query(
      `insert into public.chart_drawings (user_id, security_id, kind, basis, points)
       values ($1, $2, 'horizontal', 'adjusted', '[{"time": "2026-09-30", "price": 100}]')`,
      [user, securityId],
    );
    await t.pool.query(`insert into public.dashboard_layouts (user_id, layout) values ($1, '[]')`, [
      user,
    ]);
    await t.pool.query(
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device)
       values ($1, $2, $3, $4, 'Chrome on Linux')`,
      [user, `https://fcm.googleapis.com/fcm/send/${user}`, `B${"A".repeat(86)}`, "A".repeat(22)],
    );
  }
});
afterAll(async () => {
  await t.drop();
});

const asUser = <T>(sub: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  withRole(t.pool, "authenticated", { sub }, fn);
const count = async (c: pg.PoolClient, table: string) =>
  Number((await c.query<{ n: string }>(`select count(*) as n from public.${table}`)).rows[0]!.n);

describe("per-user tables", () => {
  it("show a signed-in user only their own rows", async () => {
    await asUser(ALICE, async (c) => {
      for (const table of [
        "watchlists",
        "watchlist_items",
        "saved_screens",
        "audit_logs",
        "strategies",
        "backtest_runs",
        "backtest_results",
        "valuation_scenarios",
        "alerts",
        "alert_events",
        "notifications",
        "chart_drawings",
        "dashboard_layouts",
        "push_subscriptions",
      ]) {
        expect(await count(c, table), table).toBe(1);
      }
      const names = await c.query<{ user_id: string }>("select user_id from public.watchlists");
      expect(names.rows.map((r) => r.user_id)).toEqual([ALICE]);
    });
  });

  it("let a user write their own rows but not someone else's", async () => {
    await asUser(ALICE, async (c) => {
      await c.query(
        `insert into public.saved_screens (user_id, name, definition)
                     values ($1, 'Mine', '{}')`,
        [ALICE],
      );
      await expect(
        c.query(
          `insert into public.saved_screens (user_id, name, definition)
                 values ($1, 'Forged', '{}')`,
          [BOB],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(ALICE, async (c) => {
      // Updates and deletes silently skip rows the user cannot see.
      const updated = await c.query(
        `update public.saved_screens set name = 'Hijacked' where user_id = $1`,
        [BOB],
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await c.query(`delete from public.watchlists where user_id = $1`, [BOB]);
      expect(deleted.rowCount).toBe(0);
    });
  });

  it("keep the audit log read-only for clients", async () => {
    await asUser(ALICE, async (c) => {
      await expect(
        c.query(`insert into public.audit_logs (user_id, action) values ($1, 'forged')`, [ALICE]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("let a user queue their own backtests but never write results", async () => {
    await asUser(ALICE, async (c) => {
      await c.query(
        `insert into public.backtest_runs (user_id, name, kind, request)
         values ($1, 'Mine', 'sweep', '{}')`,
        [ALICE],
      );
    });
    await asUser(ALICE, async (c) => {
      await expect(
        c.query(
          `insert into public.backtest_runs (user_id, name, kind, request)
           values ($1, 'Forged', 'single', '{}')`,
          [BOB],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(ALICE, async (c) => {
      await expect(
        c.query(
          `insert into public.backtest_results (run_id, user_id, summary, report, inputs)
           values ($1, $2, '{}', '{}', '{}')`,
          [runIds.get(ALICE), ALICE],
        ),
      ).rejects.toThrow(/permission denied/);
    });
    await asUser(ALICE, async (c) => {
      await expect(c.query(`update public.backtest_results set summary = '{}'`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("refuse inconsistent run states", async () => {
    const insert = (status: string, snapshot: string | null = null) =>
      t.pool.query(
        `insert into public.backtest_runs (user_id, name, kind, request, status, data_snapshot_id)
         values ($1, 'State', 'single', '{}', $2, $3)`,
        [ALICE, status, snapshot],
      );
    // Succeeded needs its code version, data fingerprint and finish time; failed, its error.
    await expect(insert("succeeded")).rejects.toThrow(/check constraint/);
    await expect(insert("failed")).rejects.toThrow(/check constraint/);
    await expect(insert("done")).rejects.toThrow(/check constraint/);
    await expect(insert("queued", "not-a-hash")).rejects.toThrow(/check constraint/);
    await expect(insert("queued", "a".repeat(64))).resolves.toBeDefined();
  });

  it("let a user mark their own notifications read, never another user's", async () => {
    await asUser(ALICE, async (c) => {
      const mine = await c.query(`update public.notifications set read_at = now()`);
      expect(mine.rowCount).toBe(1);
      const theirs = await c.query(`delete from public.notifications where user_id = $1`, [BOB]);
      expect(theirs.rowCount).toBe(0);
    });
  });

  it("keep alert targets and notification links well-formed (migration 15)", async () => {
    const screen = await t.pool.query<{ screen_id: string }>(
      `select screen_id from public.saved_screens where user_id = $1 limit 1`,
      [ALICE],
    );
    const insert = (security: string | null, screenId: string | null, kind: string) =>
      t.pool.query(
        `insert into public.alerts (user_id, security_id, screen_id, kind, params)
         values ($1, $2, $3, $4, '{}')`,
        [ALICE, security, screenId, kind],
      );
    await expect(
      insert(null, screen.rows[0]!.screen_id, "screen_membership"),
    ).resolves.toBeDefined();
    await expect(insert(securityId, null, "screen_membership")).rejects.toThrow(/check constraint/);
    await expect(insert(null, null, "price_above")).rejects.toThrow(/check constraint/);
    await expect(insert(securityId, screen.rows[0]!.screen_id, "rsi_below")).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert(securityId, null, "telepathy")).rejects.toThrow(/check constraint/);

    const event = await t.pool.query<{ event_id: string }>(
      `select event_id from public.alert_events where user_id = $1`,
      [BOB],
    );
    const link = (href: string) =>
      t.pool.query(`update public.notifications set href = $2 where event_id = $1`, [
        event.rows[0]!.event_id,
        href,
      ]);
    await expect(link("https://www.sec.gov/Archives/edgar/data/42/x.htm")).resolves.toBeDefined();
    await expect(link("/screener?saved=1")).resolves.toBeDefined();
    for (const bad of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      await expect(link(bad), bad).rejects.toThrow(/check constraint/);
    }
  });

  it("keep drawings well-formed (migration 16)", async () => {
    const draw = (kind: string, points: string, label: string | null = null) =>
      t.pool.query(
        `insert into public.chart_drawings (user_id, security_id, kind, basis, points, label)
         values ($1, $2, $3, 'raw', $4::jsonb, $5)`,
        [ALICE, securityId, kind, points, label],
      );
    const one = '[{"time": "2026-09-30", "price": 1}]';
    await expect(draw("text", one, "Breakout")).resolves.toBeDefined();
    await expect(draw("squiggle", one)).rejects.toThrow(/check constraint/);
    await expect(draw("trendline", "[]")).rejects.toThrow(/check constraint/);
    await expect(draw("trendline", `[${"{},".repeat(2)}{}]`)).rejects.toThrow(/check constraint/);
    await expect(draw("horizontal", '{"time": "x"}')).rejects.toThrow(/check constraint/);
    await expect(draw("text", one, "")).rejects.toThrow(/check constraint/);
  });

  it("give anonymous clients nothing", async () => {
    await withRole(t.pool, "anon", {}, async (c) => {
      await expect(c.query("select * from public.watchlists")).rejects.toThrow(/permission denied/);
    });
  });
});
