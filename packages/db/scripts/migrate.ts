import { migrateUp } from "../src/migrations";
import { run, targetUrl, withClient } from "./cli-support";

run(async () => {
  const applied = await withClient(targetUrl(), (c) => migrateUp(c, { log: console.log }));
  console.log(
    applied.length === 0 ? "Database is up to date." : `Applied ${applied.length} migration(s).`,
  );
});
