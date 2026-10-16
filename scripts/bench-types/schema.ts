// The synthetic schema the benchmark measures, described once in memory: `renderSchema` writes it as
// Prisma schema text and `renderFactories` exercises it, so a relation the factory file names always
// exists in the client it compiles against. Every shape is arithmetic over model indices, so two runs
// produce the same text byte for byte.

export const MODEL_COUNT = 100;

const JOIN = 98;
const JOIN_CHILD = 99;

export interface Model {
  index: number;
  name: string;
  key: string;
  // A scalar no other model declares: the library resolves a row to its model by shape, and two
  // models with the same row shape would leave every value of either ambiguous.
  label: string;
  // The primary key columns where the key is compound; `undefined` for an autoincrement `id`.
  compoundId: string[] | undefined;
  compoundUniques: string[][];
}

export interface BelongsTo {
  kind: "belongs-to";
  name: string;
  child: number;
  parent: number;
  required: boolean;
  field: string;
  inverse: string;
  columns: string[];
  references: string[];
}

export interface ManyToMany {
  kind: "many-to-many";
  name: string;
  left: number;
  right: number;
  field: string;
}

export type Relation = BelongsTo | ManyToMany;

export interface Schema {
  models: Model[];
  relations: Relation[];
}

function pad(index: number): string {
  return String(index).padStart(2, "0");
}

function model(index: number): Model {
  return {
    index,
    name: `Model${pad(index)}`,
    key: `model${pad(index)}`,
    label: `label${pad(index)}`,
    compoundId: undefined,
    compoundUniques: [],
  };
}

/**
 * The synthetic schema: 100 models joined by required and optional belongs-to relations, has-many
 * inverses, self-relations, implicit many-to-many relations, and one explicit join model keyed on a
 * compound `@@id` that another model points at through its compound foreign key.
 *
 * A required belongs-to always points at a lower index, so factory definitions referencing their
 * required parents never reference one another in a cycle.
 *
 * @example
 * ```ts
 * const { models, relations } = describeSchema();
 * ```
 */
export function describeSchema(): Schema {
  const models = Array.from({ length: MODEL_COUNT }, (_, index) => model(index));
  const relations: Relation[] = [];

  const legs = ["leftId", "rightId"];
  const join = models[JOIN];
  if (join === undefined) throw new Error("The join model is missing from the schema.");
  join.compoundId = legs;
  join.compoundUniques = [["rightId", join.label]];

  const belongsTo = (child: number, parent: number, required: boolean, columns?: string[]) => {
    const id = String(relations.length).padStart(3, "0");
    const references = models[parent]?.compoundId ?? ["id"];
    relations.push({
      kind: "belongs-to",
      name: `r${id}`,
      child,
      parent,
      required,
      field: `to${id}`,
      inverse: `from${id}`,
      columns:
        columns ?? references.map((reference) => `to${id}${reference.charAt(0).toUpperCase()}${reference.slice(1)}`),
      references,
    });
  };

  for (let index = 1; index < MODEL_COUNT; index += 1) belongsTo(index, Math.floor((index - 1) / 2), true);
  for (let index = 0; index < MODEL_COUNT; index += 1) belongsTo(index, (index + 1) % MODEL_COUNT, false);
  for (let index = 4; index < MODEL_COUNT; index += 2) belongsTo(index, index - 3, false);
  for (let index = 0; index < MODEL_COUNT; index += 10) belongsTo(index, index, false);

  for (let index = 0; index < MODEL_COUNT; index += 3) {
    const id = String(relations.length).padStart(3, "0");
    relations.push({
      kind: "many-to-many",
      name: `r${id}`,
      left: index,
      right: (index + 7) % MODEL_COUNT,
      field: `with${id}`,
    });
  }

  belongsTo(JOIN, 1, true, ["leftId"]);
  belongsTo(JOIN, 2, true, ["rightId"]);
  belongsTo(JOIN_CHILD, JOIN, true);

  return { models, relations };
}

function fieldsOf(schema: Schema, current: Model): string[] {
  const lines: string[] = [];
  if (current.compoundId === undefined) lines.push("id Int @id @default(autoincrement())");
  lines.push(`${current.label} String`);

  for (const relation of schema.relations) {
    if (relation.kind === "many-to-many") {
      const other =
        relation.left === current.index ? relation.right : relation.right === current.index ? relation.left : undefined;
      if (other !== undefined) lines.push(`${relation.field} ${nameOf(schema, other)}[] @relation("${relation.name}")`);
      continue;
    }

    if (relation.child === current.index) {
      const optional = relation.required ? "" : "?";
      const link = `fields: [${relation.columns.join(", ")}], references: [${relation.references.join(", ")}]`;
      lines.push(
        `${relation.field} ${nameOf(schema, relation.parent)}${optional} @relation("${relation.name}", ${link})`,
      );
      for (const column of relation.columns) lines.push(`${column} Int${optional}`);
    }
    if (relation.parent === current.index) {
      lines.push(`${relation.inverse} ${nameOf(schema, relation.child)}[] @relation("${relation.name}")`);
    }
  }

  if (current.compoundId !== undefined) lines.push(`@@id([${current.compoundId.join(", ")}])`);
  for (const unique of current.compoundUniques) lines.push(`@@unique([${unique.join(", ")}])`);

  return lines;
}

/**
 * Looks a model up by index.
 *
 * @example
 * ```ts
 * const root = modelAt(schema, 0); // Model00
 * ```
 */
export function modelAt(schema: Schema, index: number): Model {
  const found = schema.models[index];
  if (found === undefined) throw new Error(`No model at index ${String(index)}.`);
  return found;
}

function nameOf(schema: Schema, index: number): string {
  return modelAt(schema, index).name;
}

/**
 * The schema as Prisma schema text, generating its client into `./client` beside the file.
 *
 * @example
 * ```ts
 * await writeFile("schema.prisma", renderSchema(describeSchema()));
 * ```
 */
export function renderSchema(schema: Schema): string {
  const header = [
    "// Generated by scripts/bench-types; do not edit.",
    "",
    "datasource db {",
    '  provider = "sqlite"',
    "}",
    "",
    "generator client {",
    '  provider = "prisma-client"',
    '  output   = "./client"',
    "}",
  ];

  const models = schema.models.map((current) =>
    [`model ${current.name} {`, ...fieldsOf(schema, current).map((line) => `  ${line}`), "}"].join("\n"),
  );

  return `${[header.join("\n"), ...models].join("\n\n")}\n`;
}
