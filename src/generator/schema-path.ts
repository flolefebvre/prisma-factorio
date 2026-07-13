import { statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Returns the directory that anchors paths relative to a Prisma schema. Since
 * Prisma 7 the schema can be a directory of `.prisma` files, so `schemaPath`
 * is either that directory (returned as-is) or a single schema file (its
 * containing directory is returned).
 *
 * @example
 * schemaDir("/app/prisma/schema.prisma"); // "/app/prisma"
 * schemaDir("/app/prisma/schema"); // "/app/prisma/schema" (multi-file schema directory)
 */
export function schemaDir(schemaPath: string): string {
  return statSync(schemaPath).isDirectory() ? schemaPath : dirname(schemaPath);
}
