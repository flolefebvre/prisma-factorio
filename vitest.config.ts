import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The Postgres lane needs a server, so only `vitest.postgres.config.ts` runs it.
    exclude: [...configDefaults.exclude, "**/*.postgres.test.ts"],
  },
});
