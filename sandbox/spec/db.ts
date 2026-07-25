import fs from "node:fs";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.ts";

const migrationsDir = path.join(import.meta.dirname, "..", "prisma", "migrations");

const schemaSql = (): string =>
  fs
    .readdirSync(migrationsDir)
    .filter((entry) => fs.existsSync(path.join(migrationsDir, entry, "migration.sql")))
    .sort()
    .map((entry) => fs.readFileSync(path.join(migrationsDir, entry, "migration.sql"), "utf8"))
    .join("\n");

/** A throwaway database seeded with the sandbox schema, one per test file. */
export const freshClient = async (name: string): Promise<PrismaClient> => {
  const file = path.join(import.meta.dirname, "..", "prisma", `test-${name}.db`);
  fs.rmSync(file, { force: true });
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  for (const statement of schemaSql().split(";")) {
    const sql = statement.trim();
    if (sql.length > 0) await client.$executeRawUnsafe(sql);
  }
  return client;
};
