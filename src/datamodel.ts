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
  const models = modelsOf(client);
  const targetTag = entryOf(models, target)?.[0];
  const fields = entryOf(models, model)?.[1].fields ?? [];

  return fields.filter((field) => field.kind === "object" && field.type === targetTag).map((field) => field.name);
}

/**
 * The one relation field of a model pointing at a target model, given outright or resolved.
 *
 * Both models are named by their delegate key. An explicit `relationField` must be one of the
 * model's relation fields pointing at the target; omitted, it resolves only where exactly one such
 * field exists. Anything else throws, naming the model pair and every field that would have served.
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
          `Pass one of ${quoted(candidates)}.`,
      );

    return relationField;
  }

  if (rest.length > 0)
    throw new TypeError(
      `The model "${model}" has more than one relation field pointing at "${target}": ${quoted(candidates)}. ` +
        "Pass the relation field explicitly.",
    );

  return only;
}
