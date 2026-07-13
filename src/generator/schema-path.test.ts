import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { schemaDir } from "./schema-path.ts";

test("a directory schema path is returned unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "prisma-factorio-"));
  try {
    expect(schemaDir(dir)).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file schema path resolves to its containing directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "prisma-factorio-"));
  try {
    const file = join(dir, "schema.prisma");
    writeFileSync(file, "");
    expect(schemaDir(file)).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
