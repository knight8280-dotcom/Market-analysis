import "server-only";
import { createDb, createPool, type Database } from "@market/db";
import { loadWebEnv } from "@market/config";

const globalForDb = globalThis as unknown as { marketDb?: Database };

/** One pool per server process (kept across dev hot reloads). */
export function db(): Database {
  if (!globalForDb.marketDb) {
    const env = loadWebEnv();
    globalForDb.marketDb = createDb(
      createPool(env.DATABASE_URL, { max: 3, applicationName: "web" }),
    );
  }
  return globalForDb.marketDb;
}
