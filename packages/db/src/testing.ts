import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, createPool, type Database } from "./client";
import { applyShim, migrateUp } from "./migrations";

/**
 * Throwaway databases for integration tests. Each package's Vitest global setup builds a
 * migrated template once; each test file then clones it (CREATE DATABASE ... TEMPLATE), which
 * takes milliseconds and isolates files from each other.
 */

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a disposable Postgres server (see .env.example).",
    );
  }
  return url;
}

export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin<T>(serverUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function assertIdent(name: string): void {
  if (!IDENT.test(name)) throw new Error(`Unsafe database name: ${name}`);
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  assertIdent(name);
  await withAdmin(serverUrl, (c) => c.query(`drop database if exists "${name}" with (force)`));
}

/** Creates an empty database, applies the Supabase shim and all migrations. */
export async function createMigratedDatabase(serverUrl: string, name: string): Promise<string> {
  assertIdent(name);
  await withAdmin(serverUrl, async (c) => {
    await c.query(`drop database if exists "${name}" with (force)`);
    await c.query(`create database "${name}"`);
  });
  const url = databaseUrl(serverUrl, name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await applyShim(client);
    await migrateUp(client);
  } finally {
    await client.end();
  }
  return url;
}

/** Rebuilds the template and removes databases left behind by earlier crashed runs. */
export async function prepareTemplate(template: string, serverUrl = requireTestDatabaseUrl()) {
  assertIdent(template);
  await withAdmin(serverUrl, async (c) => {
    const { rows } = await c.query<{ datname: string }>(
      "select datname from pg_database where datname like $1",
      [`${template}\\_t\\_%`],
    );
    for (const { datname } of rows) {
      assertIdent(datname);
      await c.query(`drop database if exists "${datname}" with (force)`);
    }
  });
  await createMigratedDatabase(serverUrl, template);
}

/**
 * Runs `fn` as a Supabase client role with the given JWT claims, inside a transaction that is
 * always rolled back. This is how Phase 1 RLS policy tests will impersonate users.
 */
export async function withRole<T>(
  pool: pg.Pool,
  role: "anon" | "authenticated" | "service_role",
  claims: Record<string, unknown>,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role, ...claims }),
    ]);
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  db: Database;
  drop(): Promise<void>;
}

export async function createTestDatabase(
  template: string,
  serverUrl = requireTestDatabaseUrl(),
): Promise<TestDatabase> {
  assertIdent(template);
  const name = `${template}_t_${randomBytes(4).toString("hex")}`;
  await withAdmin(serverUrl, (c) => c.query(`create database "${name}" template "${template}"`));
  const url = databaseUrl(serverUrl, name);
  const pool = createPool(url, { max: 5, applicationName: "test" });
  const db = createDb(pool);
  return {
    name,
    url,
    pool,
    db,
    async drop() {
      // End the pool directly: Kysely creates its driver lazily, so db.destroy() would leave the
      // pool open if a test only used raw queries.
      await pool.end();
      await dropDatabase(serverUrl, name);
    },
  };
}
