import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.postgres.test.ts"],
    globalSetup: ["src/tests/postgres/global-setup.ts"],
  },
});
