#!/usr/bin/env node
// Prisma generator entry point. Registered in the user's schema as:
//   generator prismaFactorio { provider = "prisma-factorio" }
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// @prisma/generator-helper is CommonJS with getter-based exports, which Node's
// ESM named-export detection cannot see; only the default import works at runtime.
import generatorHelper from "@prisma/generator-helper";
import { emitFactoryFiles } from "./generator/emit.ts";

const { generatorHandler } = generatorHelper;

generatorHandler({
  onManifest: () => ({
    prettyName: "prisma-factorio",
    defaultOutput: "generated/prisma-factorio",
  }),
  onGenerate: async (options) => {
    const output = options.generator.output?.value;
    if (output === undefined || output === null) {
      throw new Error("prisma-factorio: the generator resolved no output directory");
    }
    const files = emitFactoryFiles(options.dmmf.datamodel);
    await Promise.all(
      files.map(async (file) => {
        const filePath = join(output, file.path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, file.content);
      }),
    );
  },
});
