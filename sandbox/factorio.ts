/**
 * Design-verification prototype for prisma-factorio.
 *
 * The library never imports the user's generated client: every model type
 * flows through the delegate generics, and the only Prisma import is the
 * runtime type namespace shared by all generated clients.
 */
import type { Types } from "@prisma/client/runtime/client";

// ---------------------------------------------------------------------------
// Type surface
// ---------------------------------------------------------------------------

export type CreateData<TDelegate> = Types.Public.Args<TDelegate, "create">["data"];
export type ModelRecord<TDelegate> = Types.Public.Result<TDelegate, Record<string, never>, "create">;

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: never[]) => unknown;

/** Keys of the client that are model delegates (they expose `create`). */
export type ModelKey<C> = {
  [K in keyof C]: C[K] extends { create: AnyFn } ? K : never;
}[keyof C] &
  string;

/** Minimal client shape a factory needs at execution time (a transaction client qualifies). */
export type ClientLike<C> = Pick<C, ModelKey<C> & keyof C>;

export interface DefinitionCtx {
  /** Monotonic counter shared by every copy of the factory, for unique values. */
  seq: number;
}

export interface StateCtx {
  attrs: Readonly<AnyRecord>;
  /** Set when this factory runs nested under a `has()` of another factory. */
  parent?: unknown;
  seq: number;
}

export type OverrideData<TDelegate> = Partial<CreateData<TDelegate>>;

export type StatesConfig<TDelegate> = Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx: StateCtx, ...args: any[]) => OverrideData<TDelegate>
>;

/**
 * Definition attributes: every create-input field, where relation fields may
 * also be another factory (created or recycled on demand) and any field may be
 * a lazy closure receiving the already-resolved attributes.
 */
export type DefinitionAttrs<Data> = {
  [K in keyof Data]: Data[K] | FactoryRef | ((attrs: AnyRecord) => Data[K]);
};

export const FACTORIO: unique symbol = Symbol("prisma-factorio.factory");

export interface FactoryRef {
  readonly [FACTORIO]: true;
}

// --- relation-key classification, computed from the create input type -------

/**
 * "many" / "one" / "none" for a create-input field. Relation fields are nested
 * inputs exposing `connect`; an index signature (Json) disqualifies; to-many
 * inputs accept an array in `connect`.
 */
type RelKind<V> = [NonNullable<V>] extends [never]
  ? "none"
  : string extends keyof NonNullable<V>
    ? "none"
    : "connect" extends keyof NonNullable<V>
      ? NonNullable<V> extends { connect?: infer Cn }
        ? Extract<NonNullable<Cn>, readonly unknown[]> extends never
          ? "one"
          : "many"
        : "none"
      : "none";

type ToManyKeys<Data> = {
  [K in keyof Data]-?: RelKind<Data[K]> extends "many" ? K : never;
}[keyof Data] &
  string;

type ToOneKeys<Data> = {
  [K in keyof Data]-?: RelKind<Data[K]> extends "one" ? K : never;
}[keyof Data] &
  string;

/**
 * Any relation key. Whether this model or the related one carries the FK is
 * not derivable from the create input alone (the checked/unchecked XOR union
 * defeats member-wise distribution), so `has` accepts every relation and the
 * execution order gives it its meaning.
 */
export type HasRelation<Data> = ToManyKeys<Data> | ToOneKeys<Data>;

/** To-one relation keys ("belongs to" targets and has-one alike). */
export type ForRelation<Data> = ToOneKeys<Data>;

// --- the public factory type ------------------------------------------------

type StateMethods<C, K extends keyof C, S, Many extends boolean> = {
  [N in keyof S]: S[N] extends (ctx: never, ...args: infer P) => unknown
    ? (...args: P) => Factory<C, K, S, Many>
    : never;
};

export type Factory<C, K extends keyof C, S, Many extends boolean = false> = FactoryCore<C, K, S, Many> &
  StateMethods<C, K, S, Many> &
  FactoryRef;

export interface FactoryCore<C, K extends keyof C, S, Many extends boolean> {
  /** Inline state: attribute overrides, or a closure receiving current attrs. */
  state(patch: OverrideData<C[K]> | ((ctx: StateCtx) => OverrideData<C[K]>)): Factory<C, K, S, Many>;
  count(n: number): Factory<C, K, S, true>;
  /** Rotating per-record state, applied by record index. */
  sequence(...values: OverrideData<C[K]>[]): Factory<C, K, S, Many>;
  /** Create related child records after this record ("has many" / "has one"). */
  has(relation: HasRelation<CreateData<C[K]>>, related: FactoryRef | AnyRecord[]): Factory<C, K, S, Many>;
  /** Associate a parent this record belongs to (factory or existing record). */
  for(relation: ForRelation<CreateData<C[K]>>, related: FactoryRef | AnyRecord): Factory<C, K, S, Many>;
  /** Reuse the given records whenever a factory for that model is needed. */
  recycle<K2 extends ModelKey<C> & keyof C>(
    model: K2,
    records: ModelRecord<C[K2]> | ModelRecord<C[K2]>[],
  ): Factory<C, K, S, Many>;
  afterMaking(hook: (attrs: AnyRecord) => void): Factory<C, K, S, Many>;
  afterCreating(
    hook: (record: ModelRecord<C[K]>, ctx: { client: ClientLike<C> }) => void | Promise<void>,
  ): Factory<C, K, S, Many>;
  /** Rebind execution to another client, e.g. an interactive transaction. */
  using(client: ClientLike<C>): Factory<C, K, S, Many>;
  make(overrides?: OverrideData<C[K]>): Many extends true ? CreateData<C[K]>[] : CreateData<C[K]>;
  create(overrides?: OverrideData<C[K]>): Promise<Many extends true ? ModelRecord<C[K]>[] : ModelRecord<C[K]>>;
  /** Batch insert via `createMany`; no relations, no per-record hooks. */
  createMany(overrides?: OverrideData<C[K]>): Promise<number>;
}

export interface FactoryConfig<C, K extends keyof C, S> {
  definition: (ctx: DefinitionCtx) => DefinitionAttrs<CreateData<C[K]>>;
  states?: S & StatesConfig<C[K]>;
  afterMaking?: (attrs: AnyRecord) => void;
  afterCreating?: (record: ModelRecord<C[K]>, ctx: { client: ClientLike<C> }) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface RuntimeField {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
}

type RuntimeModels = Record<string, { fields: RuntimeField[] }>;

interface Pool {
  records: AnyRecord[];
  cursor: number;
}

type InternalStateFn = (ctx: StateCtx, ...args: unknown[]) => AnyRecord;
type InternalHook = (record: AnyRecord, ctx: { client: unknown }) => void | Promise<void>;

type Patch =
  | { kind: "object"; attrs: AnyRecord }
  | { kind: "fn"; fn: (ctx: StateCtx) => AnyRecord }
  | { kind: "named"; name: string; args: unknown[] };

interface FactoryState {
  /** Client captured at define time; also the runtime-datamodel source. */
  baseClient: AnyRecord;
  /** Client used for queries; swapped by `using()`. */
  client: AnyRecord;
  model: string;
  definition: (ctx: DefinitionCtx) => AnyRecord;
  states: Record<string, InternalStateFn>;
  patches: Patch[];
  seqValues: AnyRecord[];
  n: number | null;
  children: { relation: string; value: FactoryImpl | AnyRecord[] }[];
  parents: { relation: string; value: FactoryImpl | AnyRecord }[];
  pools: Map<string, Pool>;
  afterMakingHooks: ((attrs: AnyRecord) => void)[];
  afterCreatingHooks: InternalHook[];
  seqBox: { n: number };
}

interface Exec {
  client: AnyRecord;
  pools: Map<string, Pool>;
  parent?: AnyRecord | undefined;
}

function uncap(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function modelsOf(client: AnyRecord): RuntimeModels {
  const dm = (client as { _runtimeDataModel?: { models: RuntimeModels } })._runtimeDataModel;
  if (!dm) throw new Error("client does not expose _runtimeDataModel");
  return dm.models;
}

function modelNameFor(models: RuntimeModels, key: string): string {
  const name = Object.keys(models).find((m) => uncap(m) === key);
  if (!name) throw new Error(`no model in the datamodel for client key "${key}"`);
  return name;
}

function relationField(models: RuntimeModels, modelName: string, relation: string): RuntimeField {
  const field = models[modelName]?.fields.find((f) => f.name === relation && f.kind === "object");
  if (!field) throw new Error(`"${relation}" is not a relation of ${modelName}`);
  return field;
}

function inverseFieldName(models: RuntimeModels, modelName: string, field: RuntimeField): string {
  const inverse = models[field.type]?.fields.find(
    (f) =>
      f.kind === "object" &&
      f.relationName === field.relationName &&
      !(field.type === modelName && f.name === field.name),
  );
  if (!inverse) {
    throw new Error(`no inverse relation for ${modelName}.${field.name} on ${field.type}`);
  }
  return inverse.name;
}

/** All scalar fields of a record: a valid `connect` filter thanks to extended where-unique. */
function scalarsOf(models: RuntimeModels, modelName: string, record: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const f of models[modelName]?.fields ?? []) {
    if (f.kind !== "object" && f.name in record) out[f.name] = record[f.name];
  }
  return out;
}

function nextFromPool(pool: Pool): AnyRecord {
  const record = pool.records[pool.cursor % pool.records.length];
  pool.cursor += 1;
  if (!record) throw new Error("recycle pool is empty");
  return record;
}

function mergePools(outer: Map<string, Pool>, own: Map<string, Pool>): Map<string, Pool> {
  if (own.size === 0) return outer;
  if (outer.size === 0) return own;
  return new Map([...outer, ...own]);
}

class FactoryImpl {
  constructor(readonly s: FactoryState) {
    (this as AnyRecord)[FACTORIO as unknown as string] = true;
    for (const name of Object.keys(s.states)) {
      if (name in this) throw new Error(`state "${name}" shadows a factory method`);
      (this as AnyRecord)[name] = (...args: unknown[]) =>
        this.derive({ patches: [...s.patches, { kind: "named", name, args }] });
    }
  }

  private derive(partial: Partial<FactoryState>): FactoryImpl {
    return new FactoryImpl({ ...this.s, ...partial });
  }

  // --- fluent API -----------------------------------------------------------

  state(patch: AnyRecord | ((ctx: StateCtx) => AnyRecord)): FactoryImpl {
    const p: Patch = typeof patch === "function" ? { kind: "fn", fn: patch } : { kind: "object", attrs: patch };
    return this.derive({ patches: [...this.s.patches, p] });
  }

  count(n: number): FactoryImpl {
    return this.derive({ n });
  }

  sequence(...values: AnyRecord[]): FactoryImpl {
    return this.derive({ seqValues: values });
  }

  has(relation: string, related: FactoryImpl | AnyRecord[]): FactoryImpl {
    return this.derive({ children: [...this.s.children, { relation, value: related }] });
  }

  for(relation: string, related: FactoryImpl | AnyRecord): FactoryImpl {
    return this.derive({ parents: [...this.s.parents, { relation, value: related }] });
  }

  recycle(model: string, records: AnyRecord | AnyRecord[]): FactoryImpl {
    const list = Array.isArray(records) ? records : [records];
    const pools = new Map(this.s.pools);
    pools.set(model, { records: list, cursor: 0 });
    return this.derive({ pools });
  }

  afterMaking(hook: (attrs: AnyRecord) => void): FactoryImpl {
    return this.derive({ afterMakingHooks: [...this.s.afterMakingHooks, hook] });
  }

  afterCreating(hook: InternalHook): FactoryImpl {
    return this.derive({ afterCreatingHooks: [...this.s.afterCreatingHooks, hook] });
  }

  using(client: AnyRecord): FactoryImpl {
    return this.derive({ client });
  }

  // --- make (pure: compiles to create-input data, no queries) ---------------

  make(overrides?: AnyRecord): AnyRecord | AnyRecord[] {
    const pools = this.s.pools;
    if (this.s.n === null) return this.makeOne(pools, undefined, 0, overrides ?? {}, {});
    return Array.from({ length: this.s.n }, (_, i) => this.makeOne(pools, undefined, i, overrides ?? {}, {}));
  }

  private makeOne(
    pools: Map<string, Pool>,
    parent: AnyRecord | undefined,
    index: number,
    overrides: AnyRecord,
    forced: AnyRecord,
    omitKey?: string,
  ): AnyRecord {
    const models = modelsOf(this.s.baseClient);
    const modelName = modelNameFor(models, this.s.model);
    const attrs = this.resolveAttrs({ client: this.s.client, pools, parent }, index, overrides, forced);
    if (omitKey) delete attrs[omitKey];

    for (const p of this.s.parents) {
      attrs[p.relation] = this.makeRelationValue(models, modelName, p.relation, p.value, pools);
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value instanceof FactoryImpl) {
        attrs[key] = this.makeRelationValue(models, modelName, key, value, pools);
      }
    }
    for (const child of this.s.children) {
      const field = relationField(models, modelName, child.relation);
      const inverse = inverseFieldName(models, modelName, field);
      if (child.value instanceof FactoryImpl) {
        const childFactory = child.value;
        const n = childFactory.s.n ?? 1;
        attrs[child.relation] = {
          create: Array.from({ length: n }, (_, i) =>
            childFactory.makeOne(mergePools(pools, childFactory.s.pools), attrs, i, {}, {}, inverse),
          ),
        };
      } else {
        attrs[child.relation] = {
          connect: child.value.map((r) => scalarsOf(models, field.type, r as AnyRecord)),
        };
      }
    }
    this.lazyPass(attrs);
    for (const hook of this.s.afterMakingHooks) hook(attrs);
    return attrs;
  }

  private makeRelationValue(
    models: RuntimeModels,
    modelName: string,
    relation: string,
    value: FactoryImpl | AnyRecord,
    pools: Map<string, Pool>,
  ): AnyRecord {
    const field = relationField(models, modelName, relation);
    if (value instanceof FactoryImpl) {
      this.assertModelMatch(value, field);
      const pool = mergePools(pools, value.s.pools).get(uncap(field.type));
      if (pool) return { connect: scalarsOf(models, field.type, nextFromPool(pool)) };
      const inverse = inverseFieldName(models, modelName, field);
      return { create: value.makeOne(pools, undefined, 0, {}, {}, inverse) };
    }
    return { connect: scalarsOf(models, field.type, value) };
  }

  // --- create ---------------------------------------------------------------

  async create(overrides?: AnyRecord): Promise<AnyRecord | AnyRecord[]> {
    const exec: Exec = { client: this.s.client, pools: this.s.pools };
    return this.createAll(exec, overrides ?? {}, {});
  }

  private async createAll(exec: Exec, overrides: AnyRecord, forced: AnyRecord): Promise<AnyRecord | AnyRecord[]> {
    if (this.s.n === null) return this.createOne(exec, 0, overrides, forced);
    const out: AnyRecord[] = [];
    for (let i = 0; i < this.s.n; i++) out.push(await this.createOne(exec, i, overrides, forced));
    return out;
  }

  private async createOne(exec: Exec, index: number, overrides: AnyRecord, forced: AnyRecord): Promise<AnyRecord> {
    const models = modelsOf(this.s.baseClient);
    const modelName = modelNameFor(models, this.s.model);
    const attrs = this.resolveAttrs(exec, index, overrides, forced);

    for (const p of this.s.parents) {
      attrs[p.relation] = await this.connectRelation(exec, models, modelName, p.relation, p.value);
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value instanceof FactoryImpl) {
        attrs[key] = await this.connectRelation(exec, models, modelName, key, value);
      }
    }
    this.lazyPass(attrs);
    for (const hook of this.s.afterMakingHooks) hook(attrs);

    const delegate = (exec.client as Record<string, { create: (args: unknown) => Promise<AnyRecord> }>)[this.s.model];
    if (!delegate) throw new Error(`client has no delegate "${this.s.model}"`);
    const record = await delegate.create({ data: attrs });

    for (const child of this.s.children) {
      await this.createChildren(exec, models, modelName, record, child);
    }
    for (const hook of this.s.afterCreatingHooks) await hook(record, { client: exec.client });
    return record;
  }

  private async connectRelation(
    exec: Exec,
    models: RuntimeModels,
    modelName: string,
    relation: string,
    value: FactoryImpl | AnyRecord,
  ): Promise<AnyRecord> {
    const field = relationField(models, modelName, relation);
    let record: AnyRecord;
    if (value instanceof FactoryImpl) {
      this.assertModelMatch(value, field);
      const pool = mergePools(exec.pools, value.s.pools).get(uncap(field.type));
      record = pool
        ? nextFromPool(pool)
        : ((await value.createOne({ client: exec.client, pools: exec.pools }, 0, {}, {})) as AnyRecord);
    } else {
      record = value;
    }
    return { connect: scalarsOf(models, field.type, record) };
  }

  private async createChildren(
    exec: Exec,
    models: RuntimeModels,
    modelName: string,
    parent: AnyRecord,
    child: { relation: string; value: FactoryImpl | AnyRecord[] },
  ): Promise<void> {
    const field = relationField(models, modelName, child.relation);
    if (child.value instanceof FactoryImpl) {
      this.assertModelMatch(child.value, field);
      const inverse = inverseFieldName(models, modelName, field);
      const parentConnect = { connect: scalarsOf(models, modelName, parent) };
      await child.value.createAll(
        {
          client: exec.client,
          pools: mergePools(exec.pools, child.value.s.pools),
          parent,
        },
        {},
        { [inverse]: parentConnect },
      );
    } else {
      const delegate = (exec.client as Record<string, { update: (args: unknown) => Promise<unknown> }>)[this.s.model];
      await delegate?.update({
        where: scalarsOf(models, modelName, parent),
        data: {
          [child.relation]: {
            connect: child.value.map((r) => scalarsOf(models, field.type, r as AnyRecord)),
          },
        },
      });
    }
  }

  // --- createMany -----------------------------------------------------------

  async createMany(overrides?: AnyRecord): Promise<number> {
    const n = this.s.n ?? 1;
    const exec: Exec = { client: this.s.client, pools: this.s.pools };
    const data: AnyRecord[] = [];
    for (let i = 0; i < n; i++) {
      const attrs = this.resolveAttrs(exec, i, overrides ?? {}, {});
      for (const value of Object.values(attrs)) {
        if (value instanceof FactoryImpl) {
          throw new Error("createMany cannot resolve relation factories; use create()");
        }
      }
      this.lazyPass(attrs);
      for (const hook of this.s.afterMakingHooks) hook(attrs);
      data.push(attrs);
    }
    const delegate = (this.s.client as Record<string, { createMany: (args: unknown) => Promise<{ count: number }> }>)[
      this.s.model
    ];
    if (!delegate) throw new Error(`client has no delegate "${this.s.model}"`);
    const result = await delegate.createMany({ data });
    return result.count;
  }

  // --- attribute resolution -------------------------------------------------

  private resolveAttrs(exec: Exec, index: number, overrides: AnyRecord, forced: AnyRecord): AnyRecord {
    const seq = this.s.seqBox.n++;
    let attrs: AnyRecord = { ...this.s.definition({ seq }) };
    for (const p of this.s.patches) {
      const ctx: StateCtx = { attrs, parent: exec.parent, seq };
      const patch =
        p.kind === "object" ? p.attrs : p.kind === "fn" ? p.fn(ctx) : this.s.states[p.name]?.(ctx, ...p.args);
      attrs = { ...attrs, ...patch };
    }
    if (this.s.seqValues.length > 0) {
      attrs = { ...attrs, ...this.s.seqValues[index % this.s.seqValues.length] };
    }
    return { ...attrs, ...overrides, ...forced };
  }

  /** Lazy attributes: plain closures resolved against the final attrs. */
  private lazyPass(attrs: AnyRecord): void {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === "function") {
        attrs[key] = (value as (a: AnyRecord) => unknown)(attrs);
      }
    }
  }

  private assertModelMatch(factory: FactoryImpl, field: RuntimeField): void {
    if (factory.s.model !== uncap(field.type)) {
      throw new Error(
        `relation "${field.name}" expects model "${uncap(field.type)}" but the factory builds "${factory.s.model}"`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function defineFactory<
  C extends object,
  K extends ModelKey<C> & keyof C,
  S extends StatesConfig<C[K]> = Record<never, never>,
>(client: C, model: K, config: FactoryConfig<C, K, S>): Factory<C, K, S> {
  const state: FactoryState = {
    baseClient: client as AnyRecord,
    client: client as AnyRecord,
    model,
    definition: config.definition as unknown as (ctx: DefinitionCtx) => AnyRecord,
    states: (config.states ?? {}) as Record<string, InternalStateFn>,
    patches: [],
    seqValues: [],
    n: null,
    children: [],
    parents: [],
    pools: new Map(),
    afterMakingHooks: config.afterMaking ? [config.afterMaking] : [],
    afterCreatingHooks: config.afterCreating ? [config.afterCreating as InternalHook] : [],
    seqBox: { n: 0 },
  };
  return new FactoryImpl(state) as unknown as Factory<C, K, S>;
}
