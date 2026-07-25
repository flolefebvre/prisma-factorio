// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // `.claude/worktrees/` holds git worktrees — full checkouts of this repo
  // nested inside it. ESLint descends into dot-directories, so without this
  // every source file gets linted once per live worktree.
  // `sandbox/` holds throwaway design-verification code with its own
  // tsconfig, outside the gates.
  globalIgnores(["dist/", "coverage/", "**/generated/", "**/.claude/", "sandbox/"]),
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
);
