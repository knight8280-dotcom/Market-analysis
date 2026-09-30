import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrations } from "../src/migrations";

async function dirsWith(files: { migrations: string[]; rollbacks: string[] }) {
  const root = await mkdtemp(path.join(tmpdir(), "migrations-"));
  const migrations = path.join(root, "migrations");
  const rollbacks = path.join(root, "rollbacks");
  await mkdir(migrations);
  await mkdir(rollbacks);
  for (const f of files.migrations) await writeFile(path.join(migrations, f), "select 1;");
  for (const f of files.rollbacks) await writeFile(path.join(rollbacks, f), "select 1;");
  return { migrations, rollbacks };
}

describe("listMigrations", () => {
  it("pairs every repository migration with a rollback script, in version order", async () => {
    const migrations = await listMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(6);
    const versions = migrations.map((m) => m.version);
    expect([...versions].sort()).toEqual(versions);
    for (const m of migrations) expect(m.downPath).toMatch(/\.down\.sql$/);
  });

  it("rejects a migration without a rollback", async () => {
    const dirs = await dirsWith({ migrations: ["20260101000000_a.sql"], rollbacks: [] });
    await expect(listMigrations(dirs)).rejects.toThrow(/has no rollback script/);
  });

  it("rejects an orphan rollback", async () => {
    const dirs = await dirsWith({
      migrations: ["20260101000000_a.sql"],
      rollbacks: ["20260101000000_a.down.sql", "20260102000000_b.down.sql"],
    });
    await expect(listMigrations(dirs)).rejects.toThrow(/has no matching migration/);
  });

  it("rejects badly named files", async () => {
    const dirs = await dirsWith({ migrations: ["2026_bad.sql"], rollbacks: [] });
    await expect(listMigrations(dirs)).rejects.toThrow(/must be named/);
  });
});
