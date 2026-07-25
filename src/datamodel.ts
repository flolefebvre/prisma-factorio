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

// A field pointing at another model is the only one the datamodel gives kind `object`; a raw foreign
// key column backing one is a scalar like any other.
function relationFields(client: unknown, model: string): DataModelField[] {
  const fields = entryOf(modelsOf(client), model)?.[1].fields ?? [];

  return fields.filter((field) => field.kind === "object");
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
        `Relation fields on "${model}": ${quoted(relationFieldsOf(client, model))}.`,
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
