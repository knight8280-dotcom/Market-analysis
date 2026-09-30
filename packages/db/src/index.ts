// Runtime entry: the query client and generated types only. Migration tooling
// (@market/db/migrations), the security audit (@market/db/security) and test helpers
// (@market/db/testing) are separate entry points so application bundles never include them.
export { sql } from "kysely";
export { createDb, createPool, type Database, type PoolOptions } from "./client";
export type * from "./types.generated";
