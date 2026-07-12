#!/usr/bin/env node
// Prisma generator entry point. Registered in the user's schema as:
//   generator prismaFactorio { provider = "prisma-factorio" }
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
    const clientOutput = options.generator.config.clientOutput;
    if (Array.isArray(clientOutput)) {
      throw new Error("prisma-factorio: the `clientOutput` option must be a single path");
    }
    const files = emitFactoryFiles({
      datamodel: options.dmmf.datamodel,
      outputDir: output,
      otherGenerators: options.otherGenerators,
      // A relative clientOutput is anchored to the schema file, matching how
      // Prisma resolves the `output` option of generator blocks.
      ...(clientOutput === undefined ? {} : { clientOutput: resolve(dirname(options.schemaPath), clientOutput) }),
    });
    await Promise.all(
      files.map(async (file) => {
        const filePath = join(output, file.path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, file.content);
      }),
    );
  },
});
