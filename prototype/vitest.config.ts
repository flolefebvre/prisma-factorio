import { defineConfig } from "vitest/config";

export default defineConfig({
  // Every test file shares one SQLite database, so they must not run concurrently.
  test: { include: ["src/**/*.test.ts"], fileParallelism: false },
});
