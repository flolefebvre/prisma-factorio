/**
 * Relation metadata read from the client's runtime data model.
 *
 * Prisma 7 no longer exports `Prisma.dmmf`; the client instead carries a slim
 * `_runtimeDataModel` holding field names, kinds, target types and relation
 * names. That is enough to pair a relation with its inverse, which is the only
 * fact the resolver cannot recover from the type level.
 */

interface RuntimeField {
  name: string;
  kind: "scalar" | "object" | "enum";
  type: string;
  relationName?: string;
}

interface RuntimeDataModel {
  models: Record<string, { fields: RuntimeField[] }>;
}

export interface RelationInfo {
  /** Payload name of the model on the other side (`"User"`). */
  target: string;
  /** Field on the target model that points back here, when there is one. */
  inverse: string | undefined;
}

export interface SchemaMetadata {
  /** Payload name (`"User"`) for a delegate name (`"user"`). */
  payloadName: (model: string) => string;
  /** Delegate name (`"user"`) for a payload name (`"User"`). */
  delegateName: (payload: string) => string;
  relation: (payload: string, field: string) => RelationInfo | undefined;
}

const readDataModel = (client: object): RuntimeDataModel => {
  const raw = client as Record<string, unknown>;
  const own = raw._runtimeDataModel;
  if (isDataModel(own)) return own;
  const parent = raw._originalClient;
  if (typeof parent === "object" && parent !== null) return readDataModel(parent);
  throw new Error("prisma-factorio could not read the Prisma runtime data model from this client.");
};

const isDataModel = (value: unknown): value is RuntimeDataModel =>
  typeof value === "object" && value !== null && "models" in value;

/**
 * Builds the relation index a client needs, once per bound client.
 *
 * @example
 * ```ts
 * const meta = readMetadata(prisma);
 * meta.relation("User", "posts"); // { target: "Post", inverse: "author" }
 * ```
 */
export const readMetadata = (client: object): SchemaMetadata => {
  const dataModel = readDataModel(client);
  const relations = new Map<string, RelationInfo>();
  const payloadNames = new Map<string, string>();
  const delegateNames = new Map<string, string>();

  // `delegate.name` is a public property carrying the model's payload name, so
  // the delegate/payload mapping never has to be guessed from casing rules.
  for (const [key, value] of Object.entries(client)) {
    const name = (value as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name in dataModel.models) {
      payloadNames.set(key, name);
      delegateNames.set(name, key);
    }
  }

  for (const [modelName, model] of Object.entries(dataModel.models)) {
    for (const field of model.fields) {
      if (field.kind !== "object" || field.relationName === undefined) continue;
      const targetFields = dataModel.models[field.type]?.fields ?? [];
      // On a self relation both sides live on the same model and share a
      // relation name, so a field must not be matched against itself.
      const inverse = targetFields.find(
        (candidate) =>
          candidate.relationName === field.relationName &&
          candidate.type === modelName &&
          !(field.type === modelName && candidate.name === field.name),
      );
      relations.set(`${modelName}.${field.name}`, {
        target: field.type,
        inverse: inverse?.name,
      });
    }
  }

  return {
    payloadName: (model) => payloadNames.get(model) ?? model,
    delegateName: (payload) => delegateNames.get(payload) ?? payload,
    relation: (payload, field) => relations.get(`${payload}.${field}`),
  };
};
