import { rollback } from "../src/migrations";
import { run, targetUrl, withClient } from "./cli-support";

// Usage: rollback [--steps N | --all] [--url <postgres-url>]. Default: one step.
run(async () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--steps");
  const steps = argv.includes("--all") ? Infinity : i >= 0 ? Number(argv[i + 1]) : 1;
  if (!(steps >= 1)) throw new Error("--steps must be a positive integer");
  const done = await withClient(targetUrl(), (c) => rollback(c, { steps, log: console.log }));
  console.log(`Rolled back ${done.length} migration(s).`);
});
