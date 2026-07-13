// Vitest global setup: pushes the fixture schema once into a throwaway
// template SQLite database before any test worker starts. Workers inherit
// PRISMA_FACTORIO_TEST_TEMPLATE_DB because they are spawned after this runs;
// integration-db.ts copies the template per client, never writing to it.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export default async function setup(): Promise<() => Promise<void>> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), "prisma-factorio-test-"));
  const templateDb = path.join(databaseDir, "template.db");
  execFileSync(
    "pnpm",
    ["exec", "prisma", "db", "push", "--schema", "src/tests/fixtures/schema.prisma", "--url", `file:${templateDb}`],
    { cwd: packageRoot, stdio: "pipe" },
  );
  process.env.PRISMA_FACTORIO_TEST_TEMPLATE_DB = templateDb;
  return async () => {
    await rm(databaseDir, { recursive: true, force: true });
  };
}
