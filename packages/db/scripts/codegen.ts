import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMigratedDatabase, dropDatabase, requireTestDatabaseUrl } from "../src/testing";
import { run } from "./cli-support";

// Generates Kysely types from a freshly migrated scratch database, so types always describe the
// migrations in the repository. `--check` fails if src/types.generated.ts is out of date.
run(async () => {
  const check = process.argv.includes("--check");
  const server = requireTestDatabaseUrl();
  const name = `codegen_${process.pid}`;
  const url = await createMigratedDatabase(server, name);
  const outFile = fileURLToPath(new URL("../src/types.generated.ts", import.meta.url));
  try {
    execFileSync(
      "kysely-codegen",
      [
        "--dialect",
        "postgres",
        "--url",
        url,
        "--include-pattern",
        "{market,ops,public}.*",
        "--date-parser",
        "string",
        "--numeric-parser",
        "string",
        "--out-file",
        outFile,
        ...(check ? ["--verify"] : []),
      ],
      { stdio: "inherit" },
    );
  } finally {
    await dropDatabase(server, name);
  }
});
