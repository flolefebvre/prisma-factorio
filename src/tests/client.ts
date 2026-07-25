import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "./generated/client.js";

/**
 * A Prisma client bound to one throwaway in-memory database holding the scratch schema.
 *
 * @example
 * ```ts
 * const prisma: TestClient = await createTestClient();
 * ```
 */
export type TestClient = PrismaClient;

const ddlPath = new URL("./generated/schema.sql", import.meta.url);

function statementsOf(ddl: string): string[] {
  return ddl.split(";").filter((statement) => statement.replace(/--[^\n]*/g, "").trim().length > 0);
}

/**
 * Opens a Prisma client on a private in-memory SQLite database with the scratch schema applied.
 *
 * Each call yields an isolated database: SQLite scopes `:memory:` to a single connection, so clients
 * never observe each other's rows and no state survives {@link disposeTestClient}. Requires
 * `pnpm generate` to have emitted the client and its DDL.
 *
 * @example
 * ```ts
 * const prisma = await createTestClient();
 * const user = await prisma.user.create({ data: { email: "ada@example.com" } });
 * await disposeTestClient(prisma);
 * ```
 */
export async function createTestClient(): Promise<TestClient> {
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: ":memory:" }) });
  const ddl = await readFile(ddlPath, "utf8");

  // `$executeRawUnsafe` rejects a payload holding more than one statement.
  for (const statement of statementsOf(ddl)) {
    await client.$executeRawUnsafe(statement);
  }

  return client;
}

/**
 * Closes a test client, discarding its in-memory database.
 *
 * @example
 * ```ts
 * afterEach(() => disposeTestClient(prisma));
 * ```
 */
export async function disposeTestClient(client: TestClient): Promise<void> {
  await client.$disconnect();
}
