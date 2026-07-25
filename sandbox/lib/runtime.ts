import type { AnyBuilder, ErasedDefinition, FactoryPlan } from "./factory.ts";
import { CYCLE, FACTORY, LAZY, REF, isMarked } from "./markers.ts";
import type { FieldContext } from "./markers.ts";
import type { SchemaMetadata } from "./metadata.ts";
import { readMetadata } from "./metadata.ts";

type Attrs = Record<string, unknown>;
interface Delegate {
  create: (args: { data: Attrs; include?: Attrs }) => Promise<Attrs>;
}

/** A record's resolved data plus the include needed to read back what it created. */
interface Built {
  data: Attrs;
  include: Attrs;
}

export interface ScopeOptions {
  /** Turns a created record into a `connect` filter. Defaults to `{ id }`. */
  identify?: (record: Attrs, model: string) => Attrs;
}

interface Scope {
  /** Mutable so `withClient` can rebind factories declared earlier. */
  current: { client: object };
  metadata: SchemaMetadata;
  definitions: Map<string, ErasedDefinition>;
  options: ScopeOptions;
  seq: { value: number };
}

const identify = (scope: Scope, record: Attrs, model: string): Attrs => {
  const custom = scope.options.identify;
  if (custom) return custom(record, model);
  if (!("id" in record)) {
    throw new Error(
      `prisma-factorio cannot connect a ${model} record without an "id" field. ` +
        `Pass an "identify" option describing this model's unique key.`,
    );
  }
  return { id: record.id };
};

const isBuilder = (value: unknown): value is FactoryImpl => value instanceof FactoryImpl;

export class FactoryImpl {
  readonly [FACTORY]: { model: string };

  constructor(
    readonly plan: FactoryPlan,
    private readonly scope: Scope,
  ) {
    this[FACTORY] = { model: plan.model };
    for (const name of Object.keys(plan.definition.states ?? {})) {
      Object.defineProperty(this, name, {
        value: () => this.state(plan.definition.states?.[name] ?? {}),
        enumerable: false,
      });
    }
  }

  derive(patch: Partial<FactoryPlan>): FactoryImpl {
    return new FactoryImpl({ ...this.plan, ...patch }, this.scope);
  }

  private get client(): object {
    return this.plan.client ?? this.scope.current.client;
  }

  private get payload(): string {
    return this.scope.metadata.payloadName(this.plan.model);
  }

  count(n: number): FactoryImpl {
    return this.derive({ count: n, cardinality: "many" });
  }

  state(patch: Attrs): FactoryImpl {
    return this.derive({ layers: [...this.plan.layers, { kind: "patch", value: patch }] });
  }

  sequence(...patches: readonly Attrs[]): FactoryImpl {
    return this.derive({ layers: [...this.plan.layers, { kind: "sequence", patches }] });
  }

  has(relation: string, source: number | AnyBuilder<never, never>): FactoryImpl {
    return this.derive({ has: [...this.plan.has, { relation, source }] });
  }

  for(relation: string, source: unknown): FactoryImpl {
    return this.derive({ for: [...this.plan.for, { relation, source }] });
  }

  attach(relation: string, ...records: readonly Attrs[]): FactoryImpl {
    return this.derive({ attach: [...this.plan.attach, { relation, records }] });
  }

  recycle(model: string, ...records: readonly Attrs[]): FactoryImpl {
    const payload = this.scope.metadata.payloadName(model);
    return this.derive({
      recycled: [...this.plan.recycled, ...records.map((record) => ({ payload, record }))],
    });
  }

  afterBuild(hook: (data: Attrs) => void | Promise<void>): FactoryImpl {
    return this.derive({ afterBuild: [...this.plan.afterBuild, hook] });
  }

  afterCreate(hook: (record: never) => void | Promise<void>): FactoryImpl {
    return this.derive({ afterCreate: [...this.plan.afterCreate, hook] });
  }

  using(client: object): FactoryImpl {
    return this.derive({ client });
  }

  /** Recycled records and an explicit client flow down into nested factories. */
  private inherit(child: FactoryImpl): FactoryImpl {
    const bound = this.plan.client ? child.derive({ client: this.plan.client }) : child;
    if (this.plan.recycled.length === 0) return bound;
    return bound.derive({ recycled: [...bound.plan.recycled, ...this.plan.recycled] });
  }

  /** Resolves the whole batch without writing anything. */
  async buildBatch(overrides?: Attrs): Promise<Built[]> {
    // A `for` parent is resolved once for the whole batch, which is what makes
    // `count(3).for("author", user)` produce one parent rather than three.
    const shared: Attrs = {};
    const sharedInclude: Attrs = {};
    for (const declaration of this.plan.for) {
      const target = this.relation(declaration.relation)?.target ?? "";
      const record = await this.resolveParent(declaration.relation, declaration.source);
      shared[declaration.relation] = { connect: identify(this.scope, record, target) };
      sharedInclude[declaration.relation] = true;
    }

    const batch: Built[] = [];
    for (let index = 0; index < this.plan.count; index += 1) {
      const data = await this.resolveData(index, overrides);
      const include: Attrs = { ...sharedInclude };
      Object.assign(data, shared);

      for (const declaration of this.plan.has) {
        const child = this.inherit(this.childFactory(declaration.relation, declaration.source));
        const inverse = this.relation(declaration.relation)?.inverse;
        const children = await child.buildBatch();
        data[declaration.relation] = { create: children.map((c) => omit(c.data, inverse)) };
        const childInclude = children[0]?.include ?? {};
        include[declaration.relation] = Object.keys(childInclude).length === 0 ? true : { include: childInclude };
      }

      for (const declaration of this.plan.attach) {
        const target = this.relation(declaration.relation)?.target ?? "";
        data[declaration.relation] = {
          connect: declaration.records.map((record) => identify(this.scope, record, target)),
        };
        include[declaration.relation] = true;
      }

      for (const hook of this.plan.afterBuild) await hook(data);
      batch.push({ data, include });
    }
    return batch;
  }

  async build(overrides?: Attrs): Promise<unknown> {
    const batch = await this.buildBatch(overrides);
    const data = batch.map((built) => built.data);
    return this.plan.cardinality === "many" ? data : data[0];
  }

  async create(overrides?: Attrs): Promise<unknown> {
    // More than one statement means a failure could leave a half-built graph,
    // so those runs go through a transaction. A client that is already inside
    // an interactive transaction has no `$transaction`, which ends the recursion.
    const multiStatement = this.plan.count > 1 || this.plan.for.length > 0;
    const begin = (this.client as { $transaction?: unknown }).$transaction;
    if (multiStatement && typeof begin === "function") {
      return (begin as (body: (tx: object) => Promise<unknown>) => Promise<unknown>).call(this.client, (tx) =>
        this.using(tx).createNow(overrides),
      );
    }
    return this.createNow(overrides);
  }

  private async createNow(overrides?: Attrs): Promise<unknown> {
    const batch = await this.buildBatch(overrides);
    const delegate = (this.client as Record<string, unknown>)[this.plan.model] as Delegate;

    const created: Attrs[] = [];
    for (const built of batch) {
      const record = await delegate.create({
        data: built.data,
        ...(Object.keys(built.include).length > 0 ? { include: built.include } : {}),
      });
      created.push(record);
      for (const hook of this.plan.afterCreate) await hook(record as never);
      await this.runChildHooks(record);
    }
    return this.plan.cardinality === "many" ? created : created[0];
  }

  private async runChildHooks(record: Attrs): Promise<void> {
    for (const declaration of this.plan.has) {
      const child = this.childFactory(declaration.relation, declaration.source);
      const values = record[declaration.relation];
      if (!Array.isArray(values)) continue;
      for (const value of values as Attrs[]) {
        for (const hook of child.plan.afterCreate) await hook(value as never);
      }
    }
  }

  private relation(field: string): { target: string; inverse: string | undefined } | undefined {
    return this.scope.metadata.relation(this.payload, field);
  }

  /** Applies the definition, then every state layer, then the call-site overrides. */
  private async resolveData(index: number, overrides?: Attrs): Promise<Attrs> {
    let attrs: Attrs = { ...this.plan.definition.fields };
    for (const layer of this.plan.layers) {
      const patch = layer.kind === "sequence" ? layer.patches[index % layer.patches.length] : layer.value;
      attrs = { ...attrs, ...(patch as Attrs) };
    }
    attrs = { ...attrs, ...overrides };

    const seq = (this.scope.seq.value += 1);
    const data: Attrs = {};
    for (const [key, value] of Object.entries(attrs)) {
      data[key] = await this.expand(key, value, { seq, index, attrs: data });
    }
    return data;
  }

  /** Turns one definition value into something Prisma's `data` accepts. */
  private async expand(key: string, value: unknown, context: FieldContext): Promise<unknown> {
    if (isMarked(value, LAZY)) {
      const resolved = (value[LAZY] as (c: FieldContext) => unknown)(context);
      return this.expand(key, resolved, context);
    }
    if (isMarked(value, CYCLE)) {
      const values = value[CYCLE] as readonly unknown[];
      return this.expand(key, values[context.index % values.length], context);
    }
    if (isMarked(value, REF)) {
      return this.expand(key, this.factoryFor(value[REF] as string), context);
    }
    if (isBuilder(value)) {
      const relation = this.relation(key);
      const target = relation?.target ?? "";
      const reused = pickRecycled(this.plan, target);
      if (reused) return { connect: identify(this.scope, reused, target) };
      const built = await this.inherit(value).buildBatch();
      return { create: omit(built[0]?.data ?? {}, relation?.inverse) };
    }
    return value;
  }

  private async resolveParent(relation: string, source: unknown): Promise<Attrs> {
    const target = this.relation(relation)?.target ?? "";
    const reused = pickRecycled(this.plan, target);
    if (reused) return reused;
    const factory = isMarked(source, REF) ? this.factoryFor(source[REF] as string) : source;
    if (!isBuilder(factory)) return factory as Attrs;
    return (await this.inherit(factory).create()) as Attrs;
  }

  private childFactory(relation: string, source: number | AnyBuilder<never, never>): FactoryImpl {
    if (typeof source !== "number") return source as unknown as FactoryImpl;
    const target = this.relation(relation)?.target ?? "";
    return this.factoryFor(this.scope.metadata.delegateName(target)).count(source);
  }

  private factoryFor(model: string): FactoryImpl {
    return factoryFor(this.scope, model);
  }
}

const omit = (data: Attrs, key: string | undefined): Attrs => {
  if (key === undefined || !(key in data)) return data;
  return Object.fromEntries(Object.entries(data).filter(([name]) => name !== key));
};

const pickRecycled = (plan: FactoryPlan, payload: string): Attrs | undefined => {
  const pool = plan.recycled.filter((entry) => entry.payload === payload);
  return pool.length === 0 ? undefined : pool[Math.floor(Math.random() * pool.length)]?.record;
};

const factoryFor = (scope: Scope, model: string): FactoryImpl => {
  const definition = scope.definitions.get(model);
  if (!definition) {
    throw new Error(`prisma-factorio has no factory defined for model "${model}".`);
  }
  return new FactoryImpl(
    {
      model,
      definition,
      layers: [],
      has: [],
      for: [],
      attach: [],
      count: 1,
      cardinality: "one",
      recycled: [],
      afterBuild: definition.afterBuild ? [definition.afterBuild] : [],
      afterCreate: definition.afterCreate ? [definition.afterCreate] : [],
      client: undefined,
    },
    scope,
  );
};

export const createScope = (
  client: object,
  options: ScopeOptions,
): {
  define: (model: string, definition: ErasedDefinition) => FactoryImpl;
  withClient: <T>(client: object, body: () => Promise<T>) => Promise<T>;
  seq: { value: number };
} => {
  const scope: Scope = {
    current: { client },
    metadata: readMetadata(client),
    definitions: new Map(),
    options,
    seq: { value: 0 },
  };
  return {
    define: (model, definition) => {
      scope.definitions.set(model, definition);
      return factoryFor(scope, model);
    },
    withClient: async (bound, body) => {
      const previous = scope.current.client;
      scope.current.client = bound;
      try {
        return await body();
      } finally {
        scope.current.client = previous;
      }
    },
    seq: scope.seq,
  };
};
