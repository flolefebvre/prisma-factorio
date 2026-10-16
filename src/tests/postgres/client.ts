import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { readSchemaStatements } from "../client.js";
import { PrismaClient } from "./generated/client.js";

/**
 * A Prisma client bound to one throwaway Postgres database holding the Postgres scratch schema.
 *
 * @example
 * ```ts
 * const prisma: PostgresTestClient = await createPostgresTestClient();
 * ```
 */
export type PostgresTestClient = PrismaClient;

const schemaPath = new URL("../../../prisma/postgres.prisma", import.meta.url);
const ddlPath = new URL("./generated/schema.sql", import.meta.url);

const databases = new WeakMap<PostgresTestClient, string>();

let schemaStatements: Promise<string[]> | undefined;

function urlOf(database: string): string {
  const url = new URL(inject("postgresUrl"));
  url.pathname = `/${database}`;
  return url.href;
}

async function onServer(statement: string): Promise<void> {
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: inject("postgresUrl"), max: 1 }) });

  try {
    await admin.$executeRawUnsafe(statement);
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Opens a Prisma client on a database of its own, created on the lane's server with the Postgres
 * scratch schema applied.
 *
 * Each call yields an isolated database, so clients never observe each other's rows, and
 * `pg_stat_database` counts one client's work alone. The client holds a single connection: a stats
 * flush and the read after it must run on the backend that did the work, and an interactive
 * `$transaction` whose callback also queries outside the transaction client waits on that one
 * connection forever. The DDL is read from disk once per process; the call rejects when that DDL is
 * missing or predates `prisma/postgres.prisma`. Runs inside the Postgres lane only, which provides
 * the server.
 *
 * @example
 * ```ts
 * const prisma = await createPostgresTestClient();
 * const user = await prisma.user.create({ data: { email: "ada@example.com", token, role: "OWNER" } });
 * await disposePostgresTestClient(prisma);
 * ```
 */
export async function createPostgresTestClient(): Promise<PostgresTestClient> {
  schemaStatements ??= readSchemaStatements(schemaPath, ddlPath);
  const statements = await schemaStatements;
  const database = `factorio_${randomUUID().replaceAll("-", "")}`;
  await onServer(`CREATE DATABASE "${database}"`);

  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlOf(database), max: 1 }) });
  databases.set(client, database);

  try {
    for (const statement of statements) {
      await client.$executeRawUnsafe(statement);
    }
  } catch (error) {
    await disposePostgresTestClient(client);
    throw error;
  }

  return client;
}

/**
 * Closes a Postgres test client and drops the database it was opened on.
 *
 * @example
 * ```ts
 * afterEach(() => disposePostgresTestClient(prisma));
 * ```
 */
export async function disposePostgresTestClient(client: PostgresTestClient): Promise<void> {
  await client.$disconnect();
  const database = databases.get(client);

  if (database !== undefined) {
    databases.delete(client);
    await onServer(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
}
