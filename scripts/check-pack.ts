// What `npm publish` would ship, asserted before it ships it. Runs after `build`: the check reads the
// tarball npm would build from the working tree, so a stale or missing `dist/` fails here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

// The rest of `docs/` is repo-internal and must not ship, so the pages are named one by one.
const ALLOWED = /^(dist\/|src\/|docs\/(for-agents|prisma-test-helper)\.md$|README\.md$|LICENSE$|package\.json$)/;
const REQUIRED = ["dist/index.js", "dist/index.d.ts", "docs/for-agents.md", "docs/prisma-test-helper.md"];

interface PackedTarball {
  files: { path: string }[];
}

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const [tarball] = JSON.parse(output) as PackedTarball[];
if (!tarball) throw new Error("npm pack reported no tarball.");

const paths = tarball.files.map((file) => file.path);
const failures: string[] = [];

const stray = paths.filter((path) => !ALLOWED.test(path));
if (stray.length > 0) failures.push(`Unexpected files in the tarball: ${stray.join(", ")}`);

// Test files are excluded by `tsconfig.build.json` and by the negations in `files`, and a published
// `src/tests/` would drag the scratch schema's generated client along with it.
const tests = paths.filter(
  (path) => path.includes(".test.") || path.startsWith("dist/tests/") || path.startsWith("src/tests/"),
);
if (tests.length > 0) failures.push(`Test files in the tarball: ${tests.join(", ")}`);

const missing = REQUIRED.filter((entry) => !paths.includes(entry));
if (missing.length > 0) failures.push(`Missing from the tarball: ${missing.join(", ")}`);

// A consumer reads the shipped markdown under `node_modules/`, where a relative link resolves only
// to a file the tarball carries. Code is stripped first: `[0](x)` in a snippet is not a link.
const shipped = new Set(paths);
for (const page of paths.filter((path) => path.endsWith(".md"))) {
  const prose = readFileSync(page, "utf8")
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  for (const [, target = ""] of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const file = posix.normalize(posix.join(posix.dirname(page), target.replace(/#.*$/, "")));
    if (!shipped.has(file)) failures.push(`Dead link in ${page}: ${target} resolves to ${file}, which does not ship`);
  }
}

// A source-mapped stack trace names the map's `sources` paths, so each must exist in the installed
// package; `sourcesContent` lets a debugger resolve the source from the map alone.
interface SourceMap {
  sources?: unknown;
  sourcesContent?: unknown;
}

for (const map of paths.filter((path) => path.startsWith("dist/") && path.endsWith(".js.map"))) {
  const { sources, sourcesContent } = JSON.parse(readFileSync(map, "utf8")) as SourceMap;
  if (!Array.isArray(sources) || sources.length === 0) {
    failures.push(`Source map ${map} lists no sources`);
    continue;
  }
  for (const source of sources) {
    const file = posix.normalize(posix.join(posix.dirname(map), String(source)));
    if (!shipped.has(file)) {
      failures.push(`Source map ${map} names ${String(source)}, which resolves to ${file} and does not ship`);
    }
  }
  const embedded = Array.isArray(sourcesContent) && sourcesContent.length === sources.length;
  if (!embedded || sourcesContent.some((content) => typeof content !== "string" || content === "")) {
    failures.push(`Source map ${map} does not embed the content of every source in sourcesContent`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Tarball holds ${String(paths.length)} files, entry points included.`);
