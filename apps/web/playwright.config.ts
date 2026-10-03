import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { e2ePushEnv } from "./e2e/push-keys";

/**
 * End-to-end tests against a production build (`next build` first). The database comes from
 * E2E_DATABASE_URL (or DATABASE_URL) and must hold synthetic data; CI loads it before the run.
 * A throwaway owner password is hashed here, so no real credential is involved.
 */
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-owner-password-123";
const PORT = Number(process.env.E2E_PORT ?? 3100);

function hash(password: string): string {
  // Lower cost than production (2^14) keeps the test fast; the format is the same.
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  return `scrypt:14:8:1:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

// Use the preinstalled Chromium when present (cloud sandboxes); CI installs its own.
const localChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: existsSync(localChromium) ? { executablePath: localChromium } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/robots.txt`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      APP_ENV: process.env.APP_ENV ?? "test",
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      OWNER_PASSWORD_HASH: hash(E2E_PASSWORD),
      SESSION_SECRET: randomBytes(32).toString("base64url"),
      // Push notifications to the specs' stand-in push service (e2e/push.spec.ts).
      ...e2ePushEnv(),
    },
  },
});
