/**
 * Design prototype for prisma-factorio. Not production code: it exists to
 * verify that the API proposed in docs/design/factory-api-proposal.md
 * typechecks against a real generated Prisma 7 client and behaves correctly
 * at runtime.
 *
 * Structure: `FactoryApi` is the fully typed public surface (a recursive type
 * so chaining preserves named states and accumulated include/count typing);
 * the `FactoryImpl` class is the loosely typed engine behind it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { faker as defaultFaker, type Faker } from "@faker-js/faker";
import type { Prisma } from "./generated/client.ts";

// ---- schema-derived types (all from the generated client, no codegen) ------

/** Keys of the client that are model delegates (have a `create` method). */
export type ModelKey<C> = {
  [K in keyof C & string]: C[K] extends { create: (args: any) => any } ? K : never;
}[keyof C & string];

type CreateData<C, K extends ModelKey<C>> = Prisma.Args<C[K], "create"> extends { data: infer D } ? D : never;

type CreateResult<C, K extends ModelKey<C>, Inc> = [keyof Inc] extends [never]
  ? Prisma.Result<C[K], object, "create">
  : Prisma.Result<C[K], { include: Inc }, "create">;

/** Relation fields of a create input: their values accept `{ connect: ... }`. */
type RelationKeys<Data> = {
  [K in keyof Data & string]: NonNullable<Data[K]> extends { connect?: any } ? K : never;
}[keyof Data & string];

/** Relations whose `connect` accepts an array (to-many). */
type HasManyKeys<Data> = {
  [K in RelationKeys<Data>]: NonNullable<Data[K]> extends { connect?: infer W }
    ? [Extract<W, readonly any[]>] extends [never]
      ? never
      : K
    : never;
}[RelationKeys<Data>];

type ConnectInput<Data, K extends RelationKeys<Data>> =
  NonNullable<Data[K]> extends { connect?: infer W } ? (W extends readonly (infer E)[] ? E : W) : never;

// ---- public API types ------------------------------------------------------

export interface DefinitionCtx {
  faker: Faker;
  /** 0-based position within the current create()/make() batch. */
  index: number;
  /** Monotonic counter shared by every build of this factory (unique values). */
  seq: number;
}

/** Scalar (non-relation) part of a create input. */
type Attrs<Data> = Omit<Data, RelationKeys<Data>>;

type StateLayer<Data> = Partial<Attrs<Data>> | ((attrs: Attrs<Data>, ctx: DefinitionCtx) => Partial<Attrs<Data>>);

type StatesConfig<Data> = Record<string, (...args: any[]) => StateLayer<Data>>;

/**
 * What a definition must return: the create input, except relation fields may
 * also be given as a factory. Homomorphic mapping preserves optionality, so a
 * required belongs-to (e.g. Post.author) must appear in the definition.
 */
type DefinitionInput<Data> = {
  [K in keyof Data]: K extends RelationKeys<Data> ? Data[K] | AnyFactory : Data[K];
};

interface AnyFactory {
  readonly model: string;
}

/**
 * Named-state methods generated from the `states` config. The self-reference
 * to FactoryApi sits inside a mapped-type property value, which TypeScript
 * resolves lazily — a direct `& StateMethods<FactoryApi<...>>` at the alias
 * top level would be an illegal circular reference (TS2456).
 */
type StateMethods<C, K extends ModelKey<C>, Inc extends Record<string, unknown>, Many extends boolean, S> = {
  [N in keyof S]: S[N] extends (...args: infer A) => any ? (...args: A) => FactoryApi<C, K, Inc, Many, S> : never;
};

interface FactoryCore<
  C,
  K extends ModelKey<C>,
  Inc extends Record<string, unknown>,
  Many extends boolean,
  S,
  Data = CreateData<C, K>,
> extends AnyFactory {
  state(layer: StateLayer<Data>): FactoryApi<C, K, Inc, Many, S>;
  sequence(...values: StateLayer<Data>[]): FactoryApi<C, K, Inc, Many, S>;
  count(n: number): FactoryApi<C, K, Inc, true, S>;
  has<R extends HasManyKeys<Data>>(name: R, target: AnyFactory): FactoryApi<C, K, Inc & Record<R, true>, Many, S>;
  for<R extends RelationKeys<Data>>(
    name: R,
    target: AnyFactory | { connect: ConnectInput<Data, R> } | { id: number | string | bigint },
  ): FactoryApi<C, K, Inc & Record<R, true>, Many, S>;
  recycle<M extends ModelKey<C>>(
    model: M,
    ...records: CreateResult<C, M, Record<never, never>>[]
  ): FactoryApi<C, K, Inc, Many, S>;
  afterMaking(cb: (data: Attrs<Data>) => void | Promise<void>): FactoryApi<C, K, Inc, Many, S>;
  afterCreating(cb: (record: CreateResult<C, K, Inc>) => void | Promise<void>): FactoryApi<C, K, Inc, Many, S>;
  using(client: unknown): FactoryApi<C, K, Inc, Many, S>;
  make(overrides?: Partial<Attrs<Data>>): Many extends true ? Attrs<Data>[] : Attrs<Data>;
  create(
    overrides?: Partial<DefinitionInput<Data>>,
  ): Promise<Many extends true ? CreateResult<C, K, Inc>[] : CreateResult<C, K, Inc>>;
}

export type FactoryApi<
  C,
  K extends ModelKey<C>,
  Inc extends Record<string, unknown>,
  Many extends boolean,
  S,
> = FactoryCore<C, K, Inc, Many, S> & StateMethods<C, K, Inc, Many, S>;

export interface DefineConfig<Data, S extends StatesConfig<Data>> {
  definition: (ctx: DefinitionCtx) => DefinitionInput<Data>;
  states?: S;
  afterMaking?: (data: Attrs<Data>) => void | Promise<void>;
  afterCreating?: (record: unknown) => void | Promise<void>;
}

// ---- implementation --------------------------------------------------------

interface Relation {
  kind: "has" | "for";
  name: string;
  /** FactoryImpl | { connect: ... } | existing record */
  target: unknown;
}

type Hook = (record: any) => void | Promise<void>;

interface Spec {
  model: string;
  definition: (ctx: DefinitionCtx) => Record<string, unknown>;
  layers: StateLayer<any>[];
  relations: Relation[];
  count: number | undefined;
  afterMaking: Hook[];
  afterCreating: Hook[];
  client: unknown;
  recycled: Map<string, unknown[]>;
  states: Record<string, (...args: any[]) => StateLayer<any>>;
}

interface Globals {
  client: () => unknown;
  faker: Faker;
}

interface ResolveCtx {
  faker: Faker;
  index: number;
  recycled: Map<string, unknown[]>;
}

const seqCounters = new Map<string, number>();

const isFactory = (v: unknown): v is FactoryImpl => v instanceof FactoryImpl;

/** Resolves a `for()`/`recycle()` target record to a `connect` argument. */
const toConnect = (record: unknown): unknown => {
  const r = record as Record<string, unknown>;
  if ("connect" in r) return r.connect;
  if ("id" in r) return { id: r.id };
  throw new Error("Cannot infer a unique key: record has no `id`. Pass { connect: {...} } explicitly.");
};

class FactoryImpl {
  constructor(
    private readonly spec: Spec,
    private readonly globals: Globals,
  ) {
    for (const [name, stateFn] of Object.entries(spec.states)) {
      (this as any)[name] = (...args: unknown[]) => this.state(stateFn(...args));
    }
  }

  get model(): string {
    return this.spec.model;
  }

  private clone(patch: Partial<Spec>): FactoryImpl {
    return new FactoryImpl({ ...this.spec, ...patch }, this.globals);
  }

  state(layer: StateLayer<any>): FactoryImpl {
    return this.clone({ layers: [...this.spec.layers, layer] });
  }

  sequence(...values: StateLayer<any>[]): FactoryImpl {
    return this.state((attrs, ctx) => {
      const value = values[ctx.index % values.length];
      if (value === undefined) throw new Error("sequence needs a value");
      return typeof value === "function" ? value(attrs, ctx) : value;
    });
  }

  count(n: number): FactoryImpl {
    return this.clone({ count: n });
  }

  has(name: string, target: unknown): FactoryImpl {
    return this.clone({
      relations: [...this.spec.relations, { kind: "has", name, target }],
    });
  }

  for(name: string, target: unknown): FactoryImpl {
    return this.clone({
      relations: [...this.spec.relations, { kind: "for", name, target }],
    });
  }

  recycle(model: string, ...records: unknown[]): FactoryImpl {
    const recycled = new Map(this.spec.recycled);
    recycled.set(model, [...(recycled.get(model) ?? []), ...records]);
    return this.clone({ recycled });
  }

  afterMaking(cb: Hook): FactoryImpl {
    return this.clone({ afterMaking: [...this.spec.afterMaking, cb] });
  }

  afterCreating(cb: Hook): FactoryImpl {
    return this.clone({ afterCreating: [...this.spec.afterCreating, cb] });
  }

  using(client: unknown): FactoryImpl {
    return this.clone({ client });
  }

  // ---- resolution ---------------------------------------------------------

  private nextSeq(): number {
    const n = (seqCounters.get(this.spec.model) ?? 0) + 1;
    seqCounters.set(this.spec.model, n);
    return n;
  }

  private resolveData(ctx: ResolveCtx, omitModel?: string): Record<string, unknown> {
    const defCtx: DefinitionCtx = {
      faker: ctx.faker,
      index: ctx.index,
      seq: this.nextSeq(),
    };
    let attrs: any = this.spec.definition(defCtx);
    for (const layer of this.spec.layers) {
      const patch = typeof layer === "function" ? layer(attrs, defCtx) : layer;
      attrs = { ...attrs, ...patch };
    }
    // When nested under a parent, the inverse relation must not appear in the
    // nested create input; by convention, drop definition-supplied factories
    // that target the parent model.
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(attrs as Record<string, unknown>).filter(
        ([, value]) => !(isFactory(value) && value.model === omitModel),
      ),
    );
    for (const rel of this.spec.relations) {
      data[rel.name] = this.resolveRelationTarget(rel.target, ctx);
    }
    // Definition values may themselves be factories (belongs-to defaults
    // declared inline); recycle() replaces nested creates with connects.
    for (const [key, value] of Object.entries(data)) {
      if (isFactory(value)) {
        data[key] = value.nestedInput(ctx, this.spec.model);
      }
    }
    return data;
  }

  private nestedInput(ctx: ResolveCtx, parentModel: string): unknown {
    const pool = ctx.recycled.get(this.spec.model);
    if (pool && pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return { connect: toConnect(pick) };
    }
    const n = this.spec.count;
    if (n === undefined) {
      return { create: this.resolveData(ctx, parentModel) };
    }
    return {
      create: Array.from({ length: n }, (_, i) => this.resolveData({ ...ctx, index: i }, parentModel)),
    };
  }

  private resolveRelationTarget(target: unknown, ctx: ResolveCtx): unknown {
    if (isFactory(target)) return target.nestedInput(ctx, this.spec.model);
    return { connect: toConnect(target) };
  }

  private includeTree(): Record<string, unknown> | undefined {
    const include: Record<string, unknown> = {};
    for (const rel of this.spec.relations) {
      if (isFactory(rel.target)) {
        const childInclude = rel.target.includeTree();
        include[rel.name] = childInclude ? { include: childInclude } : true;
      } else {
        include[rel.name] = true;
      }
    }
    return Object.keys(include).length === 0 ? undefined : include;
  }

  private async runAfterCreating(records: unknown[]): Promise<void> {
    for (const record of records) {
      for (const hook of this.spec.afterCreating) await hook(record);
      for (const rel of this.spec.relations) {
        if (!isFactory(rel.target)) continue;
        const value = (record as Record<string, unknown>)[rel.name];
        if (value === undefined) continue;
        await rel.target.runAfterCreating(Array.isArray(value) ? value : [value]);
      }
    }
  }

  // ---- terminal operations ------------------------------------------------

  private buildOne(index: number, overrides?: Record<string, unknown>): Record<string, unknown> {
    const ctx: ResolveCtx = {
      faker: this.globals.faker,
      index,
      recycled: this.spec.recycled,
    };
    const data = this.resolveData(ctx);
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        data[key] = isFactory(value) ? value.nestedInput(ctx, this.spec.model) : value;
      }
    }
    return data;
  }

  make(overrides?: Record<string, unknown>): unknown {
    const n = this.spec.count ?? 1;
    const built = Array.from({ length: n }, (_, i) => this.buildOne(i, overrides));
    for (const data of built) {
      for (const hook of this.spec.afterMaking) void hook(data);
    }
    return this.spec.count === undefined ? built[0] : built;
  }

  async create(overrides?: Record<string, unknown>): Promise<unknown> {
    const client: any = this.spec.client ?? this.globals.client();
    const delegate = client[this.spec.model];
    const include = this.includeTree();
    const n = this.spec.count ?? 1;
    const records: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const data = this.buildOne(i, overrides);
      // Prisma rejects explicitly-undefined args keys, so only pass `include`
      // when there is something to include.
      records.push(await delegate.create(include ? { data, include } : { data }));
    }
    await this.runAfterCreating(records);
    return this.spec.count === undefined ? records[0] : records;
  }
}

// ---- entry point -----------------------------------------------------------

export function createFactorio<C>(options?: { faker?: Faker }) {
  let boundClient: unknown;
  const globals: Globals = {
    client: () => {
      if (!boundClient) throw new Error("No client bound: call factorio.use(prisma) first.");
      return boundClient;
    },
    faker: options?.faker ?? defaultFaker,
  };

  function define<K extends ModelKey<C>, const S extends StatesConfig<CreateData<C, K>> = Record<never, never>>(
    model: K,
    config: DefineConfig<CreateData<C, K>, S>,
  ): FactoryApi<C, K, Record<never, never>, false, S> {
    const impl = new FactoryImpl(
      {
        model,
        definition: config.definition,
        layers: [],
        relations: [],
        count: undefined,
        afterMaking: config.afterMaking ? [config.afterMaking as Hook] : [],
        afterCreating: config.afterCreating ? [config.afterCreating as Hook] : [],
        client: undefined,
        recycled: new Map(),
        states: config.states ?? {},
      },
      globals,
    );
    return impl as unknown as FactoryApi<C, K, Record<never, never>, false, S>;
  }

  return {
    define,
    use(client: C) {
      boundClient = client;
    },
  };
}
