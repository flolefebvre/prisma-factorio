// Real-SQLite side of the test harness. The vitest global setup
// (global-setup.ts) pushes the fixture schema once into a template database
// and publishes its path through PRISMA_FACTORIO_TEST_TEMPLATE_DB; this
// module hands out clients on private copies of that template.

import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/client/client.ts";

/**
 * Creates a Prisma client backed by a private copy of the template SQLite
 * database pushed by the vitest global setup. Every call gets its own
 * database file, so clients — and the test files or workers holding them —
 * never see each other's rows. Callers own the client and disconnect it.
 *
 * @example
 * const prisma = await createIntegrationClient();
 * initPrismaFactorio({ prisma });
 * const user = await UserFactory.new().create();
 * await prisma.$disconnect();
 */
export async function createIntegrationClient(): Promise<PrismaClient> {
  const templateDb = process.env.PRISMA_FACTORIO_TEST_TEMPLATE_DB;
  if (templateDb === undefined) {
    throw new Error(
      "PRISMA_FACTORIO_TEST_TEMPLATE_DB is not set; the vitest global setup (src/tests/global-setup.ts) did not run.",
    );
  }
  const databaseFile = path.join(path.dirname(templateDb), `client-${randomUUID()}.db`);
  await copyFile(templateDb, databaseFile);
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databaseFile}` }) });
}
