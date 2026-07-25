import { buildFactory } from "./factory.ts";
import type { StateMap } from "./factory.ts";
import type { CreateInput, Model, ModelKey, RelationKey, ResolveContext, WhereUnique } from "./types.ts";

export type { ModelKey, CreateInput, Model, RelationKey, ResolveContext, WhereUnique };

type Cardinality = "one" | "many";

/** A definition value: a literal, a lazy function of the attributes resolved so far, or a factory. */
type Value<C, K extends ModelKey<C>, F extends keyof CreateInput<C, K>> =
  | CreateInput<C, K>[F]
  | ((attrs: Partial<CreateInput<C, K>>, ctx: ResolveContext) => CreateInput<C, K>[F])
  | AnyFactory<C>;

/** The shape a `define`/`state` callback returns. */
export type Attributes<C, K extends ModelKey<C>> = {
  [F in keyof CreateInput<C, K>]?: Value<C, K, F>;
};

/** Every field name of the create input, across both its checked and unchecked variants. */
export type FieldName<C, K extends ModelKey<C>> =
  CreateInput<C, K> extends infer U ? (U extends unknown ? keyof U : never) : never;

/**
 * `T`, plus a `never` for every key that is not a field of the model.
 *
 * TypeScript applies excess-property checking only to object literals in a direct
 * assignment, never to literals returned from a callback or inferred through a generic.
 * Without this, a field-name typo inside `define`, `state` or an override is silently
 * accepted and only fails at runtime.
 */
export type Exact<C, K extends ModelKey<C>, T> = T & Record<Exclude<keyof T, FieldName<C, K>>, never>;

/** The `connect` selector a relation field accepts, used to tie a relation to its target model. */
type ConnectOf<C, K extends ModelKey<C>, F extends RelationKey<C, K>> =
  NonNullable<CreateInput<C, K>[F]> extends { connect?: infer X } ? NonNullable<X> : never;

/**
 * A factory whose target model is compatible with relation field `F` of model `K`.
 *
 * The link is established through the relation's `connect` selector: a factory for model `MK`
 * fits field `F` only when `MK`'s unique selector is accepted by that field.
 */
type RelatedFactory<C, K extends ModelKey<C>, F extends RelationKey<C, K>> = {
  [MK in ModelKey<C>]: WhereUnique<C, MK> extends ConnectOf<C, K, F> ? FactoryFor<MK> : never;
}[ModelKey<C>];

/** Structural marker carrying a factory's model key, so relations can be matched by target. */
export interface FactoryFor<K> {
  readonly __model: K;
}

type AnyFactory<C> = FactoryFor<ModelKey<C>>;

export interface FactoryMethods<
  C,
  K extends ModelKey<C>,
  S extends StateMap,
  Card extends Cardinality,
> extends FactoryFor<K> {
  /** Produce `n` records instead of one; flips `make`/`create` to return arrays. */
  count(n: number): Factory<C, K, S, "many">;

  /**
   * Apply an inline state transformation.
   *
   * Values may be literals, nested factories, or per-field functions of the attributes
   * resolved so far — the same vocabulary as `define`.
   */
  state<T extends Attributes<C, K>>(patch: Exact<C, K, T>): Factory<C, K, S, Card>;

  /** Cycle the given attribute sets across the batch, one per index. */
  sequence<T extends Attributes<C, K>>(...entries: Exact<C, K, T>[]): Factory<C, K, S, Card>;

  /** Attach a relation: a factory for the related model, or a raw Prisma nested write. */
  with<F extends RelationKey<C, K>>(
    field: F,
    spec: RelatedFactory<C, K, F> | CreateInput<C, K>[F],
  ): Factory<C, K, S, Card>;

  /** Reuse the given rows for every nested factory targeting `model`. */
  recycle<MK extends ModelKey<C>>(model: MK, rows: Model<C, MK> | Model<C, MK>[]): Factory<C, K, S, Card>;

  afterMaking(hook: (data: CreateInput<C, K>) => void): Factory<C, K, S, Card>;
  afterCreating(hook: (row: Model<C, K>) => void | Promise<void>): Factory<C, K, S, Card>;

  /** Resolve attributes without touching the database. */
  make<T extends Attributes<C, K>>(
    overrides?: Exact<C, K, T>,
  ): Card extends "many" ? CreateInput<C, K>[] : CreateInput<C, K>;

  /** Resolve attributes and persist them via `client[K].create()`. */
  create<T extends Attributes<C, K>>(
    overrides?: Exact<C, K, T>,
  ): Promise<Card extends "many" ? Model<C, K>[] : Model<C, K>>;
}

/** State methods declared in `states` become chainable methods that preserve cardinality. */
export type Factory<
  C,
  K extends ModelKey<C>,
  S extends StateMap = StateMap,
  Card extends Cardinality = "one",
> = FactoryMethods<C, K, S, Card> & {
  [N in keyof S]: (...args: Parameters<S[N]>) => Factory<C, K, S, Card>;
};

export interface FactoryOptions<C, K extends ModelKey<C>, S extends StateMap, D> {
  /** Default attributes for the model. */
  define: (ctx: ResolveContext) => Exact<C, K, D>;
  /** Named, chainable state transformations. */
  states?: S;
  /** How to build a unique selector from a persisted row. Defaults to `{ id }`. */
  identify?: (row: Model<C, K>) => WhereUnique<C, K>;
}

/**
 * Define a model factory bound to a Prisma client.
 *
 * @example
 * ```ts
 * const userFactory = defineFactory(prisma, "user", {
 *   define: ({ seq }) => ({ email: `user${seq}@example.com`, name: "Jane" }),
 *   states: { admin: () => ({ role: "admin" }) },
 * });
 * const admin = await userFactory.admin().create();
 * ```
 */
export function defineFactory<
  C,
  const K extends ModelKey<C>,
  D extends Attributes<C, K>,
  S extends StateMap = Record<never, never>,
>(client: C, model: K, options: FactoryOptions<C, K, S, D>): Factory<C, K, S, "one"> {
  const states = options.states ?? ({} as S);
  const base = buildFactory({
    client: client as Record<string, unknown>,
    modelKey: model,
    define: (ctx) => options.define(ctx) as unknown as Record<string, unknown>,
    identify: (row) =>
      options.identify ? (options.identify(row as Model<C, K>) as Record<string, unknown>) : { id: row["id"] },
    steps: [],
    count: 1,
    many: false,
    afterMaking: [],
    afterCreating: [],
    seqCounter: { value: 0 },
  });
  return attachStates(base, states) as Factory<C, K, S, "one">;
}

/** Wrap a built factory so declared states appear as chainable methods on every returned instance. */
function attachStates(target: unknown, states: StateMap): unknown {
  const node = target as Record<string, unknown>;
  const wrapped: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const key of Reflect.ownKeys(node)) {
    const value = node[key as string];
    wrapped[key as string] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(node, args);
            return isBuilder(result) ? attachStates(result, states) : result;
          }
        : value;
  }

  for (const [name, factoryState] of Object.entries(states)) {
    wrapped[name] = (...args: unknown[]) => {
      const patch = (factoryState as (...a: unknown[]) => unknown)(...args);
      const next = (node["state"] as (p: unknown) => unknown)(patch);
      return attachStates(next, states);
    };
  }

  return wrapped;
}

function isBuilder(value: unknown): boolean {
  return typeof value === "object" && value !== null && "make" in value && "create" in value;
}
