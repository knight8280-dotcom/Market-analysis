import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, withRole, type TestDatabase } from "../src/testing";
import { TEMPLATE } from "./global-setup";

/**
 * Row-level security on the per-user tables (migrations 10, 13 and 14): a signed-in user sees and
 * changes only their own rows; anonymous clients see nothing; the audit log and backtest results
 * are read-only to clients.
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

  it("give anonymous clients nothing", async () => {
    await withRole(t.pool, "anon", {}, async (c) => {
      await expect(c.query("select * from public.watchlists")).rejects.toThrow(/permission denied/);
    });
  });
});
