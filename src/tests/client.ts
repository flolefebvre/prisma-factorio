import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { readFile, stat } from "node:fs/promises";
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

const schemaPath = new URL("../../prisma/schema.prisma", import.meta.url);
const ddlPath = new URL("./generated/schema.sql", import.meta.url);

// A single quote inside a SQLite literal is written as two quotes, so a literal ends on the first
// quote that is not immediately followed by another.
function endOfLiteral(script: string, start: number): number {
  let index = start + 1;

  while (index < script.length) {
    if (script.charAt(index) !== "'") {
      index += 1;
    } else if (script.charAt(index + 1) === "'") {
      index += 2;
    } else {
      return index + 1;
    }
  }

  return index;
}

function endOfLineComment(script: string, start: number): number {
  const newline = script.indexOf("\n", start);
  return newline === -1 ? script.length : newline + 1;
}

/**
 * Splits a SQL script into the statements it holds, one per terminating semicolon.
 *
 * A semicolon inside a single-quoted literal or a `--` line comment does not terminate a statement.
 * Blank and comment-only fragments are dropped, and a line comment stays attached to the statement
 * that follows it, so every returned statement runs on its own.
 *
 * @example
 * ```ts
 * statementsOf("-- seed\nINSERT INTO \"a\" VALUES ('x; y');\nSELECT 1;");
 * // ['-- seed\nINSERT INTO "a" VALUES (\'x; y\')', "SELECT 1"]
 * ```
 */
export function statementsOf(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let runnable = false;

  while (index < script.length) {
    const char = script.charAt(index);

    if (char === ";") {
      if (runnable) statements.push(script.slice(start, index).trim());
      index += 1;
      start = index;
      runnable = false;
    } else if (char === "'") {
      runnable = true;
      index = endOfLiteral(script, index);
    } else if (char === "-" && script.charAt(index + 1) === "-") {
      index = endOfLineComment(script, index);
    } else {
      runnable ||= char.trim().length > 0;
      index += 1;
    }
  }

  if (runnable) statements.push(script.slice(start).trim());

  return statements;
}

async function readSchemaStatements(): Promise<string[]> {
  const [schema, ddl] = await Promise.all([stat(schemaPath), stat(ddlPath)]);

  if (schema.mtimeMs > ddl.mtimeMs) {
    throw new Error(
      "src/tests/generated/schema.sql is older than prisma/schema.prisma. Run `pnpm generate` to rebuild the test harness.",
    );
  }

  return statementsOf(await readFile(ddlPath, "utf8"));
}

let schemaStatements: Promise<string[]> | undefined;

/**
 * Opens a Prisma client on a private in-memory SQLite database with the scratch schema applied.
 *
 * Each call yields an isolated database: SQLite scopes `:memory:` to a single connection, so clients
 * never observe each other's rows and no state survives {@link disposeTestClient}. The DDL is read
 * from disk once per process; the call rejects when that DDL predates `prisma/schema.prisma`, which
 * means `pnpm generate` has not run since the scratch schema last changed.
 *
 * @example
 * ```ts
 * const prisma = await createTestClient();
 * const user = await prisma.user.create({ data: { email: "ada@example.com" } });
 * await disposeTestClient(prisma);
 * ```
 */
export async function createTestClient(): Promise<TestClient> {
  schemaStatements ??= readSchemaStatements();
  const statements = await schemaStatements;
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: ":memory:" }) });

  try {
    // `$executeRawUnsafe` rejects a payload holding more than one statement.
    for (const statement of statements) {
      await client.$executeRawUnsafe(statement);
    }
  } catch (error) {
    await disposeTestClient(client);
    throw error;
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
