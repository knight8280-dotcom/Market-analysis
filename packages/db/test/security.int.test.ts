import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDatabaseSecurity } from "../src/security";
import { createTestDatabase, withRole, type TestDatabase } from "../src/testing";
import { TEMPLATE } from "./global-setup";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
});
afterAll(async () => {
  await t.drop();
});

describe("database security audit", () => {
  it("finds no violations in the migrated schema", async () => {
    const client = await t.pool.connect();
    try {
      expect(await auditDatabaseSecurity(client)).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("catches a table created without row-level security", async () => {
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("create table public.rls_probe (id int)");
      await client.query("create table market.rls_probe (id int)");
      const violations = await auditDatabaseSecurity(client);
      expect(violations).toEqual(
        expect.arrayContaining([
          { kind: "rls_disabled", object: "public.rls_probe" },
          { kind: "rls_disabled", object: "market.rls_probe" },
        ]),
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("catches a grant that would expose a private schema to client roles", async () => {
    const client = await t.pool.connect();
    try {
      await client.query("begin");
      await client.query("grant usage on schema market to anon");
      await client.query("grant select on market.securities to anon");
      const violations = await auditDatabaseSecurity(client);
      expect(violations).toEqual(
        expect.arrayContaining([
          { kind: "schema_usage", object: "market", role: "anon" },
          { kind: "table_privilege", object: "market.securities", role: "anon" },
        ]),
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("client roles", () => {
  for (const role of ["anon", "authenticated"] as const) {
    it(`${role} cannot read market or ops data`, async () => {
      await expect(
        withRole(t.pool, role, { sub: "00000000-0000-0000-0000-000000000001" }, (c) =>
          c.query("select * from market.prices_daily limit 1"),
        ),
      ).rejects.toThrow(/permission denied for schema market/);
      await expect(
        withRole(t.pool, role, {}, (c) => c.query("select * from ops.alerts limit 1")),
      ).rejects.toThrow(/permission denied for schema ops/);
    });
  }

  it("withRole exposes JWT claims to auth.uid()", async () => {
    const uid = "11111111-2222-3333-4444-555555555555";
    const result = await withRole(t.pool, "authenticated", { sub: uid }, (c) =>
      c.query<{ uid: string }>("select auth.uid()::text as uid"),
    );
    expect(result.rows[0]!.uid).toBe(uid);
  });
});
