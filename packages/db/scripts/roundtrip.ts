import pg from "pg";
import {
  applyShim,
  listMigrations,
  migrateUp,
  rollback,
  schemaFingerprint,
} from "../src/migrations";
import { databaseUrl, dropDatabase, requireTestDatabaseUrl } from "../src/testing";
import { run } from "./cli-support";

// Proves every rollback script works and that re-applying restores an identical schema
// (spec MUST-NOT #9, §10 "tested rollback script"). Runs on a scratch database.
run(async () => {
  const server = requireTestDatabaseUrl();
  const name = `roundtrip_${process.pid}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();

  const client = new pg.Client({ connectionString: databaseUrl(server, name) });
  await client.connect();
  try {
    await applyShim(client);
    const migrations = await listMigrations();
    await migrateUp(client);
    const baseline = await schemaFingerprint(client);
    console.log(`up: ${migrations.length} migrations, fingerprint ${baseline.hash.slice(0, 12)}`);

    // Undo k migrations and re-apply them, for every k: each rollback script runs, and the schema
    // it leaves behind is exactly what the earlier migrations produce.
    for (let k = 1; k <= migrations.length; k += 1) {
      await rollback(client, { steps: k });
      await migrateUp(client);
      const again = await schemaFingerprint(client);
      if (again.hash !== baseline.hash) {
        const before = new Set(baseline.lines);
        const after = new Set(again.lines);
        const removed = baseline.lines.filter((l) => !after.has(l));
        const added = again.lines.filter((l) => !before.has(l));
        throw new Error(
          `Schema differs after rolling back ${k} and re-applying:\n` +
            removed.map((l) => `  - ${l}`).join("\n") +
            "\n" +
            added.map((l) => `  + ${l}`).join("\n"),
        );
      }
      console.log(`down ${k} → up: identical`);
    }

    await rollback(client, { steps: Infinity });
    const { rows } = await client.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname in ('market', 'ops')",
    );
    if (rows.length > 0) {
      throw new Error(
        `Full rollback left schemas behind: ${rows.map((r) => r.nspname).join(", ")}`,
      );
    }
    console.log("full rollback: market and ops schemas removed");
  } finally {
    await client.end();
    await dropDatabase(server, name);
  }
  console.log("Migration round trip passed.");
});
