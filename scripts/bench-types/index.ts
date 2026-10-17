// The factory program imports the control program, so the difference between their counts is the
// library's own share.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderControl, renderFactories } from "./factories.ts";
import { describeSchema, renderSchema } from "./schema.ts";

interface Measurement {
  instantiations: number;
  checkTime: string;
  memory: string;
}

const generated = fileURLToPath(new URL("generated/", import.meta.url));
const schemaPath = `${generated}schema.prisma`;

function generate(): void {
  const schema = describeSchema();
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(schemaPath, renderSchema(schema));
  writeFileSync(`${generated}control.ts`, renderControl());
  writeFileSync(`${generated}factories.ts`, renderFactories(schema));
  execFileSync("prisma", ["generate", "--schema", schemaPath, "--no-hints"], { stdio: "inherit" });
}

function statistic(output: string, name: string): string {
  const match = new RegExp(`^${name}:\\s+(\\S+)`, "m").exec(output);
  if (match?.[1] === undefined) throw new Error(`tsc reported no "${name}".`);
  return match[1];
}

function failedOutput(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("stdout" in error)) return undefined;
  return String(error.stdout);
}

// A program that does not compile reports diagnostics that measure nothing, so an error ends the run
// before any number is read.
function measure(name: string, config: string): Measurement {
  const project = fileURLToPath(new URL(config, import.meta.url));
  let output: string;
  try {
    output = execFileSync("tsc", ["-p", project, "--noEmit", "--extendedDiagnostics"], { encoding: "utf8" });
  } catch (error) {
    const stdout = failedOutput(error);
    if (stdout === undefined) throw error;
    console.error(stdout);
    console.error(`The ${name} program does not compile, so its cost cannot be measured.`);
    process.exit(1);
  }

  return {
    instantiations: Number(statistic(output, "Instantiations")),
    checkTime: statistic(output, "Check time"),
    memory: statistic(output, "Memory used"),
  };
}

interface Budget {
  instantiations: number;
}

function readBudget(): number {
  const budget = JSON.parse(readFileSync(new URL("budget.json", import.meta.url), "utf8")) as Budget;
  if (!Number.isInteger(budget.instantiations)) throw new Error("budget.json holds no integer `instantiations`.");
  return budget.instantiations;
}

function row(label: string, instantiations: string, checkTime = "", memory = ""): string {
  return `${label.padEnd(16)}${instantiations.padStart(16)}${checkTime.padStart(14)}${memory.padStart(14)}`;
}

generate();
const control = measure("control", "tsconfig.control.json");
const factories = measure("factories", "tsconfig.factories.json");

console.log(row("", "instantiations", "check time", "memory"));
console.log(row("control", String(control.instantiations), control.checkTime, control.memory));
console.log(row("factories", String(factories.instantiations), factories.checkTime, factories.memory));
console.log(row("library share", String(factories.instantiations - control.instantiations)));

const budget = readBudget();
if (factories.instantiations > budget) {
  console.error(
    [
      `The factory file costs ${String(factories.instantiations)} instantiations, over the budget of ${String(budget)} in scripts/bench-types/budget.json.`,
      "Bring the cost back under the budget, or raise the budget and state the measured cost in the pull request body.",
    ].join("\n"),
  );
  process.exit(1);
}

if (factories.instantiations * 1.2 < budget) {
  console.log(
    `The budget of ${String(budget)} in scripts/bench-types/budget.json can be lowered to ${String(Math.round(factories.instantiations * 1.2))}: the cost is ${String(factories.instantiations)}.`,
  );
}
