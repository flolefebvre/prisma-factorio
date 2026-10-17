import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const page = read("../docs/for-agents.md");

function section(heading: string): string {
  const start = page.indexOf(`\n## ${heading}\n`);
  expect(start, `"## ${heading}" in docs/for-agents.md`).toBeGreaterThan(-1);
  const end = page.indexOf("\n## ", start + 1);
  return page.slice(start, end === -1 ? undefined : end);
}

test("the Rules section is context7.json's rules, entry for entry and in order", () => {
  const { rules } = JSON.parse(read("../context7.json")) as { rules: string[] };
  const numbered = [...section("Rules").matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]);

  expect(numbered).toEqual(rules);
});

test("the import map lists exactly what the package root exports", () => {
  const exported = [...read("./index.ts").matchAll(/\{([^}]*)\}/g)]
    .flatMap(([, names = ""]) => names.split(","))
    .map((name) => name.replace(/^\s*type\s+/, "").trim())
    .filter(Boolean);
  const row = section("Import map")
    .split("\n")
    .find((line) => line.startsWith("| `@flefebvre/prisma-factorio`"));
  const [, , exports = ""] = (row ?? "").split("|");
  const listed = [...exports.matchAll(/`(\w+)`/g)].map(([, name]) => name);

  expect(listed.sort()).toEqual(exported.sort());
});
