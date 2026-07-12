import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolves the package's own "prisma-factorio/factories" specifier, used
    // by generated fixture code, to the source instead of the dist build; the
    // tsconfig `paths` entry is the typecheck-side counterpart.
    alias: {
      "prisma-factorio/factories": fileURLToPath(new URL("./src/factories/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
