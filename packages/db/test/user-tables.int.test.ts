import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, withRole, type TestDatabase } from "../src/testing";
import { TEMPLATE } from "./global-setup";

/**
 * Row-level security on the per-user tables (migration 10): a signed-in user sees and changes
 * only their own rows; anonymous clients see nothing; the audit log is read-only to clients.
 */
const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";

let t: TestDatabase;
let securityId: string;

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
      for (const table of ["watchlists", "watchlist_items", "saved_screens", "audit_logs"]) {
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

  it("give anonymous clients nothing", async () => {
    await withRole(t.pool, "anon", {}, async (c) => {
      await expect(c.query("select * from public.watchlists")).rejects.toThrow(/permission denied/);
    });
  });
});
