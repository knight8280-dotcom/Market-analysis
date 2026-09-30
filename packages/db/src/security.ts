import type pg from "pg";
import { APP_SCHEMAS } from "./migrations";

/** Roles Supabase hands to browser clients (anon key / signed-in users). */
export const CLIENT_ROLES = ["anon", "authenticated"] as const;
/** Schemas no client role may touch at all. */
export const PRIVATE_SCHEMAS = ["market", "ops"] as const;

export interface SecurityViolation {
  kind: "rls_disabled" | "schema_usage" | "table_privilege" | "function_execute";
  object: string;
  role?: string;
}

/**
 * Checks the database-level rules from spec §7/§8:
 * - row-level security is enabled on every table (including partitions) in our schemas;
 * - client roles cannot use the private schemas or any table/function in them.
 * Returns an empty list when everything is in order.
 */
export async function auditDatabaseSecurity(client: pg.ClientBase): Promise<SecurityViolation[]> {
  const violations: SecurityViolation[] = [];

  const noRls = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relrowsecurity
     order by 1`,
    [APP_SCHEMAS],
  );
  for (const { name } of noRls.rows) violations.push({ kind: "rls_disabled", object: name });

  for (const role of CLIENT_ROLES) {
    const usage = await client.query<{ name: string }>(
      `select nspname as name from pg_namespace
       where nspname = any($1) and has_schema_privilege($2, oid, 'USAGE')`,
      [PRIVATE_SCHEMAS, role],
    );
    for (const { name } of usage.rows)
      violations.push({ kind: "schema_usage", object: name, role });

    const tables = await client.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege($2, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
       order by 1`,
      [PRIVATE_SCHEMAS, role],
    );
    for (const { name } of tables.rows)
      violations.push({ kind: "table_privilege", object: name, role });

    const functions = await client.query<{ name: string }>(
      `select p.oid::regprocedure::text as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = any($1) and has_function_privilege($2, p.oid, 'EXECUTE')
       order by 1`,
      [PRIVATE_SCHEMAS, role],
    );
    for (const { name } of functions.rows) {
      violations.push({ kind: "function_execute", object: name, role });
    }
  }
  return violations;
}
