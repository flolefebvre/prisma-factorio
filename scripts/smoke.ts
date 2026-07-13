// Smoke test of the published-package path: packs the tarball, installs it in
// a throwaway project, and runs a real `prisma generate` against the compiled
// bin. Lives outside src/ so vitest and the build never pick it up; run it
// with `pnpm smoke`.
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_FILE_MARKER } from "../src/generator/emit.ts";

const packageRoot = join(import.meta.dirname, "..");

const SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator prismaFactorio {
  provider = "prisma-factorio"
  output   = "./generated/prisma-factorio"
}

model User {
  id    Int    @id @default(autoincrement())
  email String
}

model Post {
  id    Int    @id @default(autoincrement())
  title String
}
`;

// pnpm skips dependency build scripts unless allowed, and `prisma generate`
// needs the artifacts that the prisma and @prisma/engines scripts produce.
const WORKSPACE_YAML = `allowBuilds:
  "@prisma/engines": true
  prisma: true
`;

function fail(step: string, detail: string): never {
  console.error(`smoke: step "${step}" failed\n${detail}`);
  process.exit(1);
}

function runPnpm(step: string, args: readonly string[], cwd: string): void {
  const result = spawnSync("pnpm", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "1", CHECKPOINT_DISABLE: "1" },
  });
  if (result.error) {
    fail(step, result.error.message);
  }
  if (result.status !== 0) {
    fail(
      step,
      `pnpm ${args.join(" ")} exited with ${String(result.status ?? result.signal)}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

async function assertFile(step: string, filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    fail(step, `expected file is missing: ${filePath}`);
  }
}

async function assertNoFile(step: string, filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    return;
  }
  fail(step, `expected file to be deleted, but it exists: ${filePath}`);
}

try {
  await access(join(packageRoot, "dist", "generator.js"));
} catch {
  fail("preflight", "dist/generator.js is missing; run `pnpm build` first (gates runs build before smoke)");
}

const repoPackageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
};
const prismaVersion = repoPackageJson.devDependencies["@prisma/client"];
if (prismaVersion === undefined) {
  fail("preflight", "could not read the @prisma/client version from package.json devDependencies");
}

const tempDir = await mkdtemp(join(tmpdir(), "prisma-factorio-smoke-"));
try {
  const tarball = join(tempDir, "prisma-factorio.tgz");
  runPnpm("pack", ["pack", "--out", tarball], packageRoot);

  const projectDir = join(tempDir, "project");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "prisma-factorio-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(join(projectDir, "pnpm-workspace.yaml"), WORKSPACE_YAML);
  await writeFile(join(projectDir, "schema.prisma"), SCHEMA);

  runPnpm("install", ["add", tarball, `prisma@${prismaVersion}`, `@prisma/client@${prismaVersion}`], projectDir);
  runPnpm("generate", ["exec", "prisma", "generate", "--schema", "schema.prisma"], projectDir);

  const factoryDir = join(projectDir, "generated", "prisma-factorio");
  await assertFile("generate", join(projectDir, "generated", "client", "models.ts"));
  for (const file of ["User.ts", "Post.ts", "index.ts"]) {
    await assertFile("generate", join(factoryDir, file));
  }
  const barrel = await readFile(join(factoryDir, "index.ts"), "utf8");
  for (const exported of ["UserFactoryBase", "PostFactoryBase"]) {
    if (!barrel.includes(exported)) {
      fail("generate", `the barrel index.ts does not export ${exported}:\n${barrel}`);
    }
  }

  await writeFile(join(factoryDir, "Stale.ts"), `${GENERATED_FILE_MARKER}\nexport const stale = true;\n`);
  await writeFile(join(factoryDir, "handwritten.ts"), "export const keep = true;\n");
  runPnpm("regenerate", ["exec", "prisma", "generate", "--schema", "schema.prisma"], projectDir);
  await assertNoFile("stale cleanup", join(factoryDir, "Stale.ts"));
  await assertFile("stale cleanup", join(factoryDir, "handwritten.ts"));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("smoke: the packed tarball generated factories through a real `prisma generate`");
