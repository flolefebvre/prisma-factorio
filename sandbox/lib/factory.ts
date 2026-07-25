import { FACTORY } from "./markers.ts";
import type {
  Cardinality,
  CreateData,
  ListRelation,
  ModelName,
  ModelObjects,
  ModelScalars,
  Produced,
  RelatedModel,
  ToOneRelation,
  Unwrap,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Definition surface
 * ------------------------------------------------------------------ */

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ValueOfUnion<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/** A factory usable as the value of a relation field inside a definition. */
export interface AnyFactory<C, M extends ModelName<C>> {
  readonly [FACTORY]: { model: M };
}

/**
 * What a definition may return: every writable key of the model's create input,
 * all optional, with relation keys additionally accepting a factory.
 */
export type DefinitionData<C, M extends ModelName<C>> = {
  [K in KeysOfUnion<CreateData<C, M>> & string]?:
    | Exclude<ValueOfUnion<CreateData<C, M>, K>, undefined>
    | (K extends keyof ModelObjects<C, M> & string ? AnyFactory<C, RelatedModel<C, M, K>> : never);
};

export type StateMap<C, M extends ModelName<C>> = Record<string, DefinitionData<C, M>>;

/**
 * A model's default attributes plus its named states.
 *
 * `fields` is a plain object rather than a callback on purpose: TypeScript
 * only applies excess property checking to an object literal in value or
 * argument position, never to one returned from a callback, so a callback
 * would silently swallow misspelled column names. Values that need the
 * sequence counter or sibling fields go through `lazy()` and `cycle()`.
 */
export interface Definition<C, M extends ModelName<C>, S extends StateMap<C, M>> {
  fields: DefinitionData<C, M>;
  states?: S;
  afterBuild?: (data: Record<string, unknown>) => void | Promise<void>;
  afterCreate?: (record: never) => void | Promise<void>;
}

export type EmptyStates = Record<never, never>;
export type EmptyInclude = Record<never, never>;

/* ------------------------------------------------------------------ *
 * Builder type
 * ------------------------------------------------------------------ */

/** Include fragment contributed by a nested factory. */
type NestedInclude<ChildInc> = keyof ChildInc extends never ? true : { include: ChildInc };

type HasSource<C, M extends ModelName<C>, K extends ListRelation<C, M>> = number | AnyBuilder<C, RelatedModel<C, M, K>>;

/** An already-created record of the model a to-one relation points at. */
export type RelatedRecord<C, M extends ModelName<C>, K extends keyof ModelObjects<C, M>> = Unwrap<
  ModelObjects<C, M>[K]
>["scalars"];

type ForSource<C, M extends ModelName<C>, K extends ToOneRelation<C, M>> =
  AnyBuilder<C, RelatedModel<C, M, K>> | RelatedRecord<C, M, K>;

/** A factory for a known model, with its states and includes left open. */
export type AnyBuilder<C, M extends ModelName<C>> = FactoryBase<
  C,
  M,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  Cardinality
>;

export interface FactoryBase<C, M extends ModelName<C>, S extends object, Inc, Card extends Cardinality> {
  readonly [FACTORY]: { model: M };

  /** Produces `n` records instead of one; `create()` then resolves to an array. */
  count(n: number): Factory<C, M, S, Inc, "many">;

  /** Merges an attribute patch over the definition. */
  state(patch: DefinitionData<C, M>): Factory<C, M, S, Inc, Card>;

  /** Cycles attribute patches across the batch, one per record. */
  sequence(...patches: readonly DefinitionData<C, M>[]): Factory<C, M, S, Inc, Card>;

  /** Creates records on a to-many relation; they come back on the result. */
  has<K extends ListRelation<C, M>, Src extends HasSource<C, M, K>>(
    relation: K,
    source: Src,
  ): Factory<C, M, S, Inc & Record<K, NestedInclude<IncludeOf<Src>>>, Card>;

  /** Attaches every record produced to one parent on a to-one relation. */
  for<K extends ToOneRelation<C, M>>(
    relation: K,
    source: ForSource<C, M, K>,
  ): Factory<C, M, S, Inc & Record<K, true>, Card>;

  /** Connects existing records to a relation instead of creating new ones. */
  attach<K extends ListRelation<C, M>>(
    relation: K,
    ...records: readonly RelatedRecord<C, M, K>[]
  ): Factory<C, M, S, Inc & Record<K, true>, Card>;

  /** Reuses the given records whenever a relation of their model is needed. */
  recycle<R extends ModelName<C>>(model: R, ...records: readonly ModelScalars<C, R>[]): Factory<C, M, S, Inc, Card>;

  afterBuild(hook: (data: Record<string, unknown>) => void | Promise<void>): Factory<C, M, S, Inc, Card>;

  afterCreate(hook: (record: Produced<C, M, Inc, "one">) => void | Promise<void>): Factory<C, M, S, Inc, Card>;

  /** Rebinds to another client, typically a transaction client. */
  using(client: C): Factory<C, M, S, Inc, Card>;

  /** Resolves attributes without touching the database. */
  build(overrides?: DefinitionData<C, M>): Promise<Card extends "many" ? CreateData<C, M>[] : CreateData<C, M>>;

  /** Persists the records and returns them, typed by the relations declared. */
  create(overrides?: DefinitionData<C, M>): Promise<Produced<C, M, Inc, Card>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IncludeOf<T> = T extends FactoryBase<any, any, any, infer Inc, Cardinality> ? Inc : EmptyInclude;

/** Named states become chainable methods alongside the built-in ones. */
export type Factory<C, M extends ModelName<C>, S extends object, Inc, Card extends Cardinality> = FactoryBase<
  C,
  M,
  S,
  Inc,
  Card
> &
  Record<keyof S & string, () => Factory<C, M, S, Inc, Card>>;

/* ------------------------------------------------------------------ *
 * Internal plan carried by every builder instance
 * ------------------------------------------------------------------ */

export type StateLayer =
  | { kind: "patch"; value: Record<string, unknown> | ((attrs: Record<string, unknown>) => unknown) }
  | { kind: "sequence"; patches: readonly unknown[] };

export interface HasDeclaration {
  relation: string;
  source: number | AnyBuilder<never, never>;
}
export interface ForDeclaration {
  relation: string;
  source: unknown;
}
export interface AttachDeclaration {
  relation: string;
  records: readonly Record<string, unknown>[];
}

/** Type-erased definition, as the resolver sees it. */
export interface ErasedDefinition {
  fields: Record<string, unknown>;
  states?: Record<string, Record<string, unknown>>;
  afterBuild?: (data: Record<string, unknown>) => void | Promise<void>;
  afterCreate?: (record: never) => void | Promise<void>;
}

export interface FactoryPlan {
  model: string;
  definition: ErasedDefinition;
  layers: readonly StateLayer[];
  has: readonly HasDeclaration[];
  for: readonly ForDeclaration[];
  attach: readonly AttachDeclaration[];
  count: number;
  cardinality: Cardinality;
  recycled: readonly { payload: string; record: Record<string, unknown> }[];
  afterBuild: readonly ((data: Record<string, unknown>) => void | Promise<void>)[];
  afterCreate: readonly ((record: never) => void | Promise<void>)[];
  client: object | undefined;
}
