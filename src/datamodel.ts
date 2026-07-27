interface DataModelField {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
}

interface DataModelModel {
  fields: DataModelField[];
}

// `_runtimeDataModel` is the client's only runtime source of relation metadata: the generated
// `Prisma` namespace no longer exports `dmmf`, and a delegate's `fields` lists scalars alone. It is
// absent from the generated `.d.ts`, so reading it needs a shape declared here. It marks no field as
// holding many records, which is what {@link holdsManyRecords} puts to the query API instead.
interface WithRuntimeDataModel {
  _runtimeDataModel?: { models: Record<string, DataModelModel> };
}

// The datamodel keys models by their tag (`Post`); the client keys delegates by lowering that tag's
// first letter alone (`post`), which no general case conversion reproduces.
function delegateKey(tag: string): string {
  return tag.charAt(0).toLowerCase() + tag.slice(1);
}

function modelsOf(client: unknown): Record<string, DataModelModel> {
  const models = (client as WithRuntimeDataModel)._runtimeDataModel?.models;

  if (models === undefined)
    throw new TypeError(
      "The client carries no relation metadata. Pass a generated Prisma client, not a hand-built object of delegates.",
    );

  return models;
}

function entryOf(models: Record<string, DataModelModel>, model: string): [string, DataModelModel] | undefined {
  return Object.entries(models).find(([tag]) => delegateKey(tag) === model);
}

function quoted(names: string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function declaredFields(client: unknown, model: string): DataModelField[] {
  return entryOf(modelsOf(client), model)?.[1].fields ?? [];
}

// A field pointing at another model is the only one the datamodel gives kind `object`; a raw foreign
// key column backing one is a scalar like any other.
function relationFields(client: unknown, model: string): DataModelField[] {
  return declaredFields(client, model).filter((field) => field.kind === "object");
}

/**
 * Every relation field a model declares, in schema order, and none of its scalars.
 *
 * The model is named by its delegate key, the same name `define` takes. A name no model answers to
 * yields no fields rather than throwing, so a client carrying a model the caller does not know about
 * is not an error.
 *
 * @example
 * ```ts
 * relationFieldsOf(prisma, "post"); // ["author", "editor", "comments", "tags"]
 * ```
 */
export function relationFieldsOf(client: unknown, model: string): string[] {
  return relationFields(client, model).map((field) => field.name);
}

/**
 * The relation fields of a model that point at a target model, in schema order.
 *
 * Both models are named by their delegate key, the same name `define` takes.
 *
 * @example
 * ```ts
 * relationFieldsTo(prisma, "post", "user"); // ["author", "editor"]
 * ```
 */
export function relationFieldsTo(client: unknown, model: string, target: string): string[] {
  const targetTag = entryOf(modelsOf(client), target)?.[0];

  return relationFields(client, model)
    .filter((field) => field.type === targetTag)
    .map((field) => field.name);
}

/**
 * The one relation field of a model pointing at a target model, given outright or resolved.
 *
 * Both models are named by their delegate key. An explicit `relationField` must be one of the
 * model's relation fields pointing at the target; omitted, it resolves only where exactly one such
 * field exists. Anything else throws, naming the model pair and listing the relation fields it holds
 * between them, which the runtime cannot narrow down to the ones a given call accepts.
 *
 * @example
 * ```ts
 * resolveRelationField(prisma, "post", "user", "editor"); // "editor"
 * ```
 */
export function resolveRelationField(client: unknown, model: string, target: string, relationField?: string): string {
  const candidates = relationFieldsTo(client, model, target);
  const [only, ...rest] = candidates;

  if (only === undefined)
    throw new TypeError(
      `The model "${model}" has no relation field pointing at "${target}". Declare the relation in the Prisma schema.`,
    );

  if (relationField !== undefined) {
    if (!candidates.includes(relationField))
      throw new TypeError(
        `The model "${model}" has no relation field "${relationField}" pointing at "${target}". ` +
          `Relation fields on "${model}" pointing at "${target}": ${quoted(candidates)}.`,
      );

    return relationField;
  }

  if (rest.length > 0)
    throw new TypeError(
      `The model "${model}" has more than one relation field pointing at "${target}". ` +
        "Pass the relation field explicitly. " +
        `Relation fields on "${model}" pointing at "${target}": ${quoted(candidates)}.`,
    );

  return only;
}

/**
 * The call a failed inverse lookup steers to for naming the relation field outright.
 *
 * A `has` layer takes the name as an option; a factory standing in a relation field holding many
 * records reaches no options at all, and is pointed at `has` instead.
 *
 * @example
 * ```ts
 * inverseRelationField(prisma, "post", "comments", "relation default");
 * ```
 */
export type InverseAdvice = "has" | "relation default";

const advised: Record<InverseAdvice, string> = {
  has: 'Pass the inverse relation field as the "inverse" option of has(). ',
  "relation default":
    "A relation default takes no options: attach the children with has(children, field, { inverse }) instead. ",
};

function fieldListing(client: unknown, model: string): string {
  const names = relationFieldsOf(client, model);

  return `Relation fields on "${model}": ${names.length === 0 ? "none" : quoted(names)}.`;
}

/**
 * The relation field a model declares under a name, checked against the fields it holds.
 *
 * The model is named by its delegate key. This is the whole of what a caller naming no model at the
 * far end can be held to — a name the model declares as a scalar and one it declares not at all are
 * reported alike — so a call carrying a target model resolves through {@link resolveRelationField}
 * instead, which narrows the candidates to that pair.
 *
 * @example
 * ```ts
 * namedRelationField(prisma, "user", "posts"); // "posts"
 * ```
 */
export function namedRelationField(client: unknown, model: string, relationField: string): string {
  if (!relationFieldsOf(client, model).includes(relationField))
    throw new TypeError(
      `The model "${model}" has no relation field "${relationField}". ${fieldListing(client, model)}`,
    );

  return relationField;
}

/**
 * The relation field a model reaches back through the relation another one of its own points along.
 *
 * The model is named by its delegate key, the relation field by the name it carries on that model.
 * The two sides of a relation are matched on the metadata pairing them rather than on their names, so
 * a relation the schema names and one it leaves unnamed answer alike. A model relating to itself
 * carries both sides, where the field asked about is never its own inverse. Metadata pairing that
 * field with anything other than exactly one relation field throws, listing the relation fields the
 * target model holds, which the runtime cannot narrow down to the ones a given call accepts. Those
 * throws steer to the `inverse` option of `has`, which `advice` redirects for a caller reaching no
 * options.
 *
 * @example
 * ```ts
 * inverseRelationField(prisma, "user", "posts"); // "author"
 * ```
 */
export function inverseRelationField(
  client: unknown,
  model: string,
  relationField: string,
  advice: InverseAdvice = "has",
): string {
  const inverseOption = advised[advice];
  const field = declaredFields(client, model).find((candidate) => candidate.name === relationField);

  if (field === undefined)
    throw new TypeError(`The model "${model}" declares no field "${relationField}". ${fieldListing(client, model)}`);

  if (field.kind !== "object")
    throw new TypeError(
      `The field "${relationField}" on the model "${model}" is not a relation field. ${fieldListing(client, model)}`,
    );

  const target = delegateKey(field.type);

  if (field.relationName === undefined)
    throw new TypeError(
      `The relation field "${relationField}" on the model "${model}" carries no metadata pairing it with a relation field on "${target}". ` +
        inverseOption +
        fieldListing(client, target),
    );

  const paired = relationFields(client, target)
    .filter((candidate) => candidate.relationName === field.relationName)
    .map((candidate) => candidate.name);
  // A model relating to itself carries both sides of one pairing, so the field the lookup starts from
  // answers that pairing alongside the inverse being looked for.
  const candidates = target === model ? paired.filter((name) => name !== relationField) : paired;
  const [only, ...rest] = candidates;

  if (only === undefined)
    throw new TypeError(
      `The model "${target}" has no relation field pairing with "${relationField}" on "${model}". ` +
        inverseOption +
        fieldListing(client, target),
    );

  if (rest.length > 0)
    throw new TypeError(
      `The model "${target}" has more than one relation field pairing with "${relationField}" on "${model}". ` +
        inverseOption +
        `Relation fields on "${target}" pairing with "${relationField}" on "${model}": ${quoted(candidates)}.`,
    );

  return only;
}

function scalarNames(models: Record<string, DataModelModel>, tag: string): string[] {
  return (models[tag]?.fields ?? []).filter((field) => field.kind !== "object").map((field) => field.name);
}

function declaredNames(models: Record<string, DataModelModel>, tag: string): string[] {
  return (models[tag]?.fields ?? []).map((field) => field.name);
}

// A row announces no model of its own, so the model it belongs to is read off the fields it carries:
// the one model a relation field points at that declares every one of them. A row loaded with
// `include` carries the relations it loaded, which is why the match is not against scalars alone.
function fittingTarget(client: unknown, model: string, row: Record<string, unknown>): string {
  const models = modelsOf(client);
  const keys = Object.keys(row);
  const tags = [...new Set(relationFields(client, model).map((field) => field.type))];
  const [only, ...rest] = tags.filter((tag) => keys.every((key) => declaredNames(models, tag).includes(key)));

  if (only === undefined || rest.length > 0)
    throw new TypeError(
      `The row fits no single model the relation fields of "${model}" point at. ` +
        "Pass the relation field explicitly. " +
        fieldListing(client, model),
    );

  return delegateKey(only);
}

function tagOf(client: unknown, model: string, relationField: string | undefined): string | undefined {
  return relationFields(client, model).find((candidate) => candidate.name === relationField)?.type;
}

function targetOf(client: unknown, model: string, relationField: string | undefined): string | undefined {
  const tag = tagOf(client, model, relationField);

  return tag === undefined ? undefined : delegateKey(tag);
}

/**
 * The fields of a row that the model at the far end of a relation field declares as scalars.
 *
 * The model is named by its delegate key, the relation field by the name it carries on that model. A
 * relation field the model does not declare hands the row back whole, having no target model to read
 * scalars off.
 *
 * @example
 * ```ts
 * targetScalars(prisma, "post", "author", user); // { id: 1, email: "ada@example.com", name: null }
 * ```
 */
export function targetScalars(
  client: unknown,
  model: string,
  relationField: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const tag = tagOf(client, model, relationField);

  if (tag === undefined) return row;

  const scalars = scalarNames(modelsOf(client), tag);

  return Object.fromEntries(Object.entries(row).filter(([key]) => scalars.includes(key)));
}

// The schema the client was generated from rides along as one inline text, the only runtime surface
// naming the fields behind a unique constraint. Like `_runtimeDataModel`, it is absent from the
// generated `.d.ts`, so reading it needs a shape declared here.
interface WithEngineConfig {
  _engineConfig?: { inlineSchema?: string };
}

interface CompoundKey {
  name: string;
  fields: string[];
}

// A `//` inside a string literal opens no comment, so the walk tracks the quotes; a backslash keeps
// the character behind it, which is how a quote written as `\"` stays inside its string.
function withoutComments(schema: string): string {
  let clean = "";
  let index = 0;
  let quoted = false;

  while (index < schema.length) {
    const char = schema.charAt(index);

    if (quoted && char === "\\" && index + 1 < schema.length) {
      clean += char + schema.charAt(index + 1);
      index += 2;
    } else if (char === '"') {
      quoted = !quoted;
      clean += char;
      index += 1;
    } else if (!quoted && char === "/" && schema.charAt(index + 1) === "/") {
      const newline = schema.indexOf("\n", index);
      index = newline === -1 ? schema.length : newline;
    } else {
      clean += char;
      index += 1;
    }
  }

  return clean;
}

// Structural scans read the mask, where string contents are spaces of their own length: a brace or
// an attribute inside a literal matches nothing, while every index still addresses `clean`.
function blankedStrings(clean: string): string {
  let mask = "";
  let index = 0;
  let quoted = false;

  while (index < clean.length) {
    const char = clean.charAt(index);

    if (quoted && char === "\\" && index + 1 < clean.length) {
      mask += "  ";
      index += 2;
    } else if (char === '"') {
      quoted = !quoted;
      mask += char;
      index += 1;
    } else {
      mask += quoted ? " " : char;
      index += 1;
    }
  }

  return mask;
}

// The index one past the close matching the opener `from` sits on, read off the mask, or -1 where
// the text runs out first.
function spanEnd(mask: string, from: number, open: string, close: string): number {
  let depth = 0;

  for (let index = from; index < mask.length; index++) {
    const char = mask.charAt(index);

    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

// A comma inside a field reference's own arguments — `title(sort: Desc)` — separates no fields.
function splitFields(listMask: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < listMask.length; index++) {
    const char = listMask.charAt(index);

    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(listMask.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(listMask.slice(start));

  return parts;
}

const identifier = /^[A-Za-z_]\w*$/;

function fieldNameOf(reference: string): string | undefined {
  const bare = (reference.split("(")[0] ?? "").trim();

  return identifier.test(bare) ? bare : undefined;
}

// The name Prisma exposes a compound constraint under: the `name` argument where the schema gives
// one, the constituent fields joined with `_` where it does not. A `name` that is present but not a
// bare identifier is left to `parsedConstraint` to refuse.
function constraintName(argClean: string, argMask: string, fields: string[]): string | undefined {
  const named = /\bname\s*:/.exec(argMask);

  if (named === null) return fields.join("_");

  const quote = argMask.indexOf('"', named.index + named[0].length);

  if (quote === -1 || argMask.slice(named.index + named[0].length, quote).trim() !== "") return undefined;

  const closing = argMask.indexOf('"', quote + 1);

  if (closing === -1) return undefined;

  const name = argClean.slice(quote + 1, closing);

  return identifier.test(name) ? name : undefined;
}

// One constraint read off an attribute's argument text, or nothing where any part of it does not
// parse cleanly: a selector built on a guess would refuse connects that work today, where a skipped
// constraint leaves the flat scalars as they always were. A single field is no compound constraint —
// Prisma exposes it as the flat scalar the splat already carries.
function parsedConstraint(argClean: string, argMask: string): CompoundKey | undefined {
  const fieldsToken = /\bfields\s*:/.exec(argMask);
  const bracket = argMask.indexOf("[", fieldsToken === null ? 0 : fieldsToken.index + fieldsToken[0].length);

  if (bracket === -1) return undefined;

  const bracketEnd = spanEnd(argMask, bracket, "[", "]");

  if (bracketEnd === -1) return undefined;

  const references = splitFields(argMask.slice(bracket + 1, bracketEnd - 1)).map(fieldNameOf);
  const fields = references.filter((reference): reference is string => reference !== undefined);

  if (fields.length < 2 || fields.length !== references.length) return undefined;

  const name = constraintName(argClean, argMask, fields);

  return name === undefined ? undefined : { name, fields };
}

// `@@index` and `@@ignore` share the prefix and are told apart by the paren the match requires
// right after the attribute's own name.
const constraintAttribute = /@@(?:id|unique)\s*\(/g;

function constraintsOf(bodyClean: string, bodyMask: string): CompoundKey[] {
  const keys: CompoundKey[] = [];

  for (const match of bodyMask.matchAll(constraintAttribute)) {
    const open = match.index + match[0].length - 1;
    const end = spanEnd(bodyMask, open, "(", ")");

    if (end === -1) continue;

    const key = parsedConstraint(bodyClean.slice(open + 1, end - 1), bodyMask.slice(open + 1, end - 1));

    if (key !== undefined) keys.push(key);
  }

  return keys;
}

const modelHeader = /(?:^|\n)\s*model\s+([A-Za-z_]\w*)\s*\{/g;

function scannedCompoundKeys(schema: string): Map<string, CompoundKey[]> {
  const clean = withoutComments(schema);
  const mask = blankedStrings(clean);
  const keys = new Map<string, CompoundKey[]>();

  for (const match of mask.matchAll(modelHeader)) {
    const tag = match[1];

    if (tag === undefined) continue;

    const open = match.index + match[0].length - 1;
    const end = spanEnd(mask, open, "{", "}");

    if (end === -1) continue;

    const constraints = constraintsOf(clean.slice(open + 1, end - 1), mask.slice(open + 1, end - 1));

    if (constraints.length > 0) keys.set(tag, constraints);
  }

  return keys;
}

// One schema text per generated client per process, so the entries stay few while a transaction
// client — a fresh wrapper per transaction — still hits the text it shares with its parent.
const compoundKeys = new Map<string, Map<string, CompoundKey[]>>();

function heldCompoundKeys(schema: string): Map<string, CompoundKey[]> {
  const held = compoundKeys.get(schema) ?? scannedCompoundKeys(schema);

  compoundKeys.set(schema, held);

  return held;
}

function targetCompoundKeys(client: unknown, tag: string): CompoundKey[] {
  const schema = (client as WithEngineConfig)._engineConfig?.inlineSchema;

  return schema === undefined ? [] : (heldCompoundKeys(schema).get(tag) ?? []);
}

/**
 * The where-clause a row satisfies on the model at the far end of a relation field: its scalars,
 * plus a compound selector for every unique constraint of that model the row can name whole.
 *
 * The model is named by its delegate key, the relation field by the name it carries on that model.
 * The runtime datamodel marks no field unique, so compound constraints are read off the schema text
 * the client carries instead; a client carrying none answers the scalars alone. A constraint adds no
 * selector where a constituent is missing from the row or holds `null` — Prisma's compound selectors
 * take values alone — or where the row already carries a scalar under the selector's name. A
 * relation field the model does not declare hands the row back whole.
 *
 * @example
 * ```ts
 * targetWhere(prisma, "user", "memberships", membership);
 * // { userId: 1, teamId: 2, role: "admin", userId_teamId: { userId: 1, teamId: 2 } }
 * ```
 */
export function targetWhere(
  client: unknown,
  model: string,
  relationField: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const where = targetScalars(client, model, relationField, row);

  for (const key of targetCompoundKeys(client, tagOf(client, model, relationField) ?? "")) {
    const values = key.fields.map((field) => row[field]);

    if (key.name in where || values.some((value) => value === null || value === undefined)) continue;

    where[key.name] = Object.fromEntries(key.fields.map((field, at) => [field, values[at]]));
  }

  return where;
}

/**
 * The one relation field of a model pointing at the model a row belongs to, given outright or
 * resolved.
 *
 * The model is named by its delegate key. An explicit `relationField` carries the model it points at,
 * so the row's own fields are read only where it is left out — or where it names no relation field at
 * all, which the throw then reports. A row fitting no single target model throws, listing every
 * relation field the model declares.
 *
 * @example
 * ```ts
 * resolveRowRelationField(prisma, "comment", { id: 1, title: "Hello", authorId: 1 }); // "post"
 * ```
 */
export function resolveRowRelationField(
  client: unknown,
  model: string,
  row: Record<string, unknown>,
  relationField?: string,
): string {
  const target = targetOf(client, model, relationField) ?? fittingTarget(client, model, row);

  return resolveRelationField(client, model, target, relationField);
}

interface Delegate {
  findFirst: (args: unknown) => Promise<unknown>;
}

function delegateOf(client: unknown, model: string): Delegate {
  const delegate = (client as Record<string, Delegate | null | undefined>)[model];

  if (delegate === undefined || delegate === null)
    throw new TypeError(
      `The client carries no delegate for the model "${model}". Pass a generated Prisma client, not its relation metadata alone.`,
    );

  // A delegate carrying every method its caller ever needed still answers no arity: the query it is
  // read off is one a hand-rolled double reaches only once a relation default stands in a field.
  if (typeof delegate.findFirst !== "function")
    throw new TypeError(
      `The delegate for the model "${model}" answers no findFirst, which a relation field's arity is read through. ` +
        "A client used with a relation default must answer findFirst on every model it carries.",
    );

  return delegate;
}

// Prisma names its error classes on the instance, which tells a query the client refused to send
// from one the database refused to answer without reading either message.
function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "PrismaClientValidationError";
}

// The keys a filter on a relation field holding many records takes, of which the probe names one the
// target model declares no field under: a field holding a single record takes that model's own
// where-input too, where a key naming one of its fields validates and answers nothing.
const manyFilters = ["some", "every", "none"];

function probeFilter(client: unknown, model: string, relationField: string): string {
  const tag = tagOf(client, model, relationField);
  const declared = tag === undefined ? [] : declaredNames(modelsOf(client), tag);
  const [free] = manyFilters.filter((key) => !declared.includes(key));

  // A model declaring a field under every one of them leaves no key a field holding a single record
  // refuses, so any of them would validate there and report that field as holding many.
  if (free === undefined)
    throw new TypeError(
      `The model at the far end of the relation field "${relationField}" on "${model}" declares a field under each of ` +
        `${quoted(manyFilters)}, which leaves the arity no filter key to be read off. ` +
        "Rename one of them in the Prisma schema.",
    );

  return free;
}

async function probeHoldsMany(client: unknown, model: string, relationField: string): Promise<boolean> {
  const filter = probeFilter(client, model, relationField);

  try {
    await delegateOf(client, model).findFirst({ where: { [relationField]: { [filter]: {} } } });
  } catch (error) {
    if (!isValidationError(error)) throw error;

    return false;
  }

  return true;
}

const arities = new WeakMap<object, Map<string, Promise<boolean>>>();

function answersOf(client: object): Map<string, Promise<boolean>> {
  const answers = arities.get(client) ?? new Map<string, Promise<boolean>>();

  arities.set(client, answers);

  return answers;
}

/**
 * Whether a relation field of a model holds many records rather than a single one.
 *
 * The model is named by its delegate key, the relation field by the name it carries on that model. A
 * name the model declares as no relation field throws, as it does for {@link namedRelationField}.
 * The runtime datamodel marks no arity, so the answer is put to the query API and held for the client
 * it was asked of: a field holding many records costs one `SELECT … LIMIT 1` the first time, and a
 * transaction client asks once of its own. A query the database refuses is rethrown rather than
 * standing for an answer, and is held on to no more than the refusal itself.
 *
 * @example
 * ```ts
 * await holdsManyRecords(prisma, "post", "comments"); // true
 * ```
 */
export async function holdsManyRecords(client: unknown, model: string, relationField: string): Promise<boolean> {
  const field = namedRelationField(client, model, relationField);
  const answers = answersOf(client as object);
  const key = `${model}.${field}`;
  const held = answers.get(key);

  if (held !== undefined) return held;

  // A query the database refused carries no arity to hold on to, so it is dropped rather than
  // answering every later ask with the same refusal.
  const probing = probeHoldsMany(client, model, field).catch((error: unknown) => {
    answers.delete(key);
    throw error;
  });

  answers.set(key, probing);

  return probing;
}
