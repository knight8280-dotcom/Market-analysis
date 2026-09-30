import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * Minimal migration runner for local dev, CI and tests.
 *
 * Migrations live in `supabase/migrations` (forward-only, the Supabase CLI layout) and each has a
 * rollback script in `supabase/rollbacks` that CI exercises (spec §10). History is kept in
 * `supabase_migrations.schema_migrations`, the table the Supabase CLI uses, so either tool sees
 * the same state. Production applies migrations with `supabase db push`.
 */

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations/", import.meta.url),
);
export const ROLLBACKS_DIR = fileURLToPath(
  new URL("../../../supabase/rollbacks/", import.meta.url),
);
export const SHIM_FILE = fileURLToPath(
  new URL("../test-support/supabase-shim.sql", import.meta.url),
);

/** Schemas owned by our migrations; the fingerprint and RLS checks cover these. */
export const APP_SCHEMAS = ["market", "ops", "public"] as const;

export interface MigrationFile {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
}

export interface MigrationDirs {
  migrations: string;
  rollbacks: string;
}

type Log = (message: string) => void;

const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const ROLLBACK_FILE = /^(\d{14})_([a-z0-9_]+)\.down\.sql$/;
// Arbitrary constant: serializes concurrent runners against one database.
const ADVISORY_LOCK_KEY = 7_311_022_406;

export async function listMigrations(
  dirs: MigrationDirs = { migrations: MIGRATIONS_DIR, rollbacks: ROLLBACKS_DIR },
): Promise<MigrationFile[]> {
  const upFiles = (await readdir(dirs.migrations)).filter((f) => f.endsWith(".sql")).sort();
  const downFiles = new Set((await readdir(dirs.rollbacks)).filter((f) => f.endsWith(".sql")));

  const migrations = upFiles.map((file) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new Error(`Migration file must be named YYYYMMDDHHMMSS_name.sql: ${file}`);
    const [, version = "", name = ""] = match;
    const down = `${version}_${name}.down.sql`;
    if (!downFiles.has(down)) {
      throw new Error(`Migration ${file} has no rollback script supabase/rollbacks/${down}`);
    }
    downFiles.delete(down);
    return {
      version,
      name,
      upPath: path.join(dirs.migrations, file),
      downPath: path.join(dirs.rollbacks, down),
    };
  });

  for (const orphan of downFiles) {
    if (ROLLBACK_FILE.test(orphan)) throw new Error(`Rollback ${orphan} has no matching migration`);
  }
  return migrations;
}

async function ensureHistoryTable(client: pg.ClientBase): Promise<void> {
  await client.query(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
  `);
}

export async function appliedVersions(client: pg.ClientBase): Promise<string[]> {
  await ensureHistoryTable(client);
  const { rows } = await client.query<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  );
  return rows.map((r) => r.version);
}

async function withLock<T>(client: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }
}

async function inTransaction(client: pg.ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query("begin");
  try {
    await fn();
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Applies every pending migration in version order, each in its own transaction. */
export async function migrateUp(
  client: pg.ClientBase,
  opts: { dirs?: MigrationDirs; log?: Log } = {},
): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const migrations = await listMigrations(opts.dirs);
  return withLock(client, async () => {
    const applied = new Set(await appliedVersions(client));
    const known = new Set(migrations.map((m) => m.version));
    const unknown = [...applied].filter((v) => !known.has(v));
    if (unknown.length > 0) {
      throw new Error(
        `Database has migrations that are not in the repository: ${unknown.join(", ")}`,
      );
    }

    const done: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      const sql = await readFile(m.upPath, "utf8");
      await inTransaction(client, async () => {
        await client.query(sql);
        await client.query(
          "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
          [m.version, m.name, [sql]],
        );
      });
      log(`applied ${m.version}_${m.name}`);
      done.push(m.version);
    }
    return done;
  });
}

/** Rolls back the latest `steps` applied migrations (all of them when steps is Infinity). */
export async function rollback(
  client: pg.ClientBase,
  opts: { steps: number; dirs?: MigrationDirs; log?: Log },
): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const byVersion = new Map((await listMigrations(opts.dirs)).map((m) => [m.version, m]));
  return withLock(client, async () => {
    const applied = (await appliedVersions(client)).reverse();
    const targets = applied.slice(0, opts.steps);
    const done: string[] = [];
    for (const version of targets) {
      const m = byVersion.get(version);
      if (!m) throw new Error(`No rollback script for applied migration ${version}`);
      const sql = await readFile(m.downPath, "utf8");
      await inTransaction(client, async () => {
        await client.query(sql);
        await client.query("delete from supabase_migrations.schema_migrations where version = $1", [
          version,
        ]);
      });
      log(`rolled back ${m.version}_${m.name}`);
      done.push(version);
    }
    return done;
  });
}

export async function applyShim(client: pg.ClientBase): Promise<void> {
  await client.query(await readFile(SHIM_FILE, "utf8"));
}

/**
 * A structural fingerprint of our schemas: relations, columns, constraints, indexes, functions,
 * views, policies, triggers and privileges. Column positions (attnum) are left out: Postgres keeps
 * a dropped column's slot, so dropping and re-adding a column moves it without any real change. Used to prove that down → up restores exactly the
 * same schema. Names are schema-qualified because search_path is pinned to pg_catalog.
 */
export async function schemaFingerprint(
  client: pg.ClientBase,
  schemas: readonly string[] = APP_SCHEMAS,
): Promise<{ hash: string; lines: string[] }> {
  const queries: Record<string, string> = {
    schema: `select nspname, coalesce(nspacl::text, '') from pg_namespace where nspname = any($1)`,
    relation: `
      select n.nspname || '.' || c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
             coalesce(array_to_string(c.reloptions, ','), ''), coalesce(pg_get_partkeydef(c.oid), ''),
             coalesce(pg_get_expr(c.relpartbound, c.oid), ''), coalesce(c.relacl::text, '')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1)`,
    column: `
      select n.nspname || '.' || c.relname || '.' || a.attname,
             format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
             coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = any($1) and a.attnum > 0 and not a.attisdropped
        and c.relkind in ('r', 'p', 'v', 'm', 'f')`,
    constraint: `
      select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = any($1)`,
    index: `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname = any($1)`,
    function: `
      select p.oid::regprocedure::text, pg_get_functiondef(p.oid), coalesce(p.proacl::text, '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) and p.prokind in ('f', 'p')`,
    view: `select schemaname || '.' || viewname, definition from pg_views where schemaname = any($1)`,
    policy: `
      select schemaname, tablename, policyname, permissive, roles::text, cmd,
             coalesce(qual, ''), coalesce(with_check, '')
      from pg_policies where schemaname = any($1)`,
    trigger: `
      select t.tgrelid::regclass::text, t.tgname, pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and not t.tgisinternal`,
    default_acl: `
      select n.nspname, d.defaclobjtype, d.defaclacl::text
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = any($1)`,
  };

  const lines: string[] = [];
  await client.query("begin");
  try {
    await client.query("set local search_path = pg_catalog");
    for (const [kind, sql] of Object.entries(queries)) {
      const { rows } = await client.query<unknown[]>({
        text: sql,
        values: [schemas],
        rowMode: "array",
      });
      for (const row of rows) {
        lines.push(`${kind}|${row.map((v) => String(v)).join("|")}`);
      }
    }
  } finally {
    await client.query("rollback");
  }
  lines.sort();
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex");
  return { hash, lines };
}
