import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.acceptance.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
