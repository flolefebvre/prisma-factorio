// What `npm publish` would ship, asserted before it ships it. Runs after `build`: the check reads the
// tarball npm would build from the working tree, so a stale or missing `dist/` fails here.
import { execFileSync } from "node:child_process";

const ALLOWED = /^(dist\/|README\.md$|LICENSE$|package\.json$)/;
const REQUIRED = ["dist/index.js", "dist/index.d.ts"];

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

// Test files are excluded by `tsconfig.build.json`, and a published `src/tests/` would drag the
// scratch schema's generated client along with it.
const tests = paths.filter((path) => path.includes(".test.") || path.startsWith("dist/tests/"));
if (tests.length > 0) failures.push(`Test files in the tarball: ${tests.join(", ")}`);

const missing = REQUIRED.filter((entry) => !paths.includes(entry));
if (missing.length > 0) failures.push(`Missing from the tarball: ${missing.join(", ")}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Tarball holds ${String(paths.length)} files, entry points included.`);
