import { applyShim } from "../src/migrations";
import { run, targetUrl, withClient } from "./cli-support";

// Applies the local stand-in for Supabase-provided roles and schemas. Refuses anything that could
// be a real Supabase project.
run(async () => {
  const appEnv = process.env.APP_ENV ?? "local";
  if (!["local", "test"].includes(appEnv)) {
    throw new Error(`Refusing to apply the Supabase shim with APP_ENV=${appEnv}.`);
  }
  await withClient(targetUrl(), async (c) => {
    const { rows } = await c.query<{ found: string | null }>(
      "select to_regclass('auth.users')::text as found",
    );
    if (rows[0]?.found) {
      throw new Error("Target has auth.users, so it looks like a real Supabase project. Refusing.");
    }
    await applyShim(c);
  });
  console.log("Supabase shim applied.");
});
