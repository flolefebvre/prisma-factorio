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
// absent from the generated `.d.ts`, so reading it needs a shape declared here.
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
 * relationFieldsOf(prisma, "post"); // ["author", "editor", "comments"]
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

function fieldListing(client: unknown, model: string): string {
  const names = relationFieldsOf(client, model);

  return `Relation fields on "${model}": ${names.length === 0 ? "none" : quoted(names)}.`;
}

/**
 * The relation field a model reaches back through the relation another one of its own points along.
 *
 * The model is named by its delegate key, the relation field by the name it carries on that model.
 * The two sides of a relation are matched on the metadata pairing them rather than on their names, so
 * a relation the schema names and one it leaves unnamed answer alike. A model relating to itself
 * carries both sides, where the field asked about is never its own inverse. Metadata pairing that
 * field with anything other than exactly one relation field throws, listing the relation fields the
 * target model holds, which the runtime cannot narrow down to the ones a given call accepts.
 *
 * @example
 * ```ts
 * inverseRelationField(prisma, "user", "posts"); // "author"
 * ```
 */
export function inverseRelationField(client: unknown, model: string, relationField: string): string {
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
        "Pass the inverse relation field explicitly. " +
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
        "Pass the inverse relation field explicitly. " +
        fieldListing(client, target),
    );

  if (rest.length > 0)
    throw new TypeError(
      `The model "${target}" has more than one relation field pairing with "${relationField}" on "${model}". ` +
        "Pass the inverse relation field explicitly. " +
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
      `The row passed to for() fits no single model the relation fields of "${model}" point at. ` +
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
