import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { GENERATED_FILE_MARKER } from "./emit.ts";

/**
 * Deletes files in `outputDir` that start with the generated-file marker but
 * are not in `keep` (paths relative to `outputDir`), so factories of renamed
 * or removed models do not linger. Files without the marker are never
 * touched, protecting user files when `output` points at an occupied
 * directory.
 *
 * @example
 * await removeStaleGeneratedFiles({
 *   outputDir: "/app/generated/prisma-factorio",
 *   keep: files.map((file) => file.path),
 * });
 */
export async function removeStaleGeneratedFiles(params: { outputDir: string; keep: readonly string[] }): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(params.outputDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const kept = new Set(params.keep);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !kept.has(entry.name))
      .map(async (entry) => {
        const filePath = join(params.outputDir, entry.name);
        const content = await readFile(filePath, "utf8");
        if (content.startsWith(GENERATED_FILE_MARKER)) {
          await rm(filePath);
        }
      }),
  );
}
