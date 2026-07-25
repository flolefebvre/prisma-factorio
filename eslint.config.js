// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // `.claude/worktrees/` holds git worktrees — full checkouts of this repo
  // nested inside it. ESLint descends into dot-directories, so without this
  // every source file gets linted once per live worktree.
  globalIgnores(["dist/", "coverage/", "**/generated/", "**/.claude/"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // `*.check.ts` files are compiled, never executed: `tsc` is the assertion.
    // Bindings exist only so their types can be inspected, and the assertion
    // helpers take phantom type parameters.
    files: ["**/*.check.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
);
