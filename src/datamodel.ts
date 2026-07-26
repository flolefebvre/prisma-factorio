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
