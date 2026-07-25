import type { CreateInput, Model, ModelKey, RelationKey, ResolveContext, Resolvable, WhereUnique } from "./types.ts";

type Attrs = Record<string, unknown>;
type Cardinality = "one" | "many";

const FACTORY = Symbol("prisma-factorio.factory");

/** A factory erased of its type parameters, for use inside the resolution engine. */
interface AnyFactory {
  [FACTORY]: true;
  modelKey: string;
  resolveMany(run: RunContext, parentModel?: string): Attrs[];
  identify(row: Attrs): Attrs;
  runAfterCreating(row: unknown, run: RunContext): Promise<void>;
}

/** Shared state for a single `make()`/`create()` call, including the recycle pool. */
interface RunContext {
  recycled: Map<string, Attrs[]>;
  afterCreating: { factory: AnyFactory; path: string[] }[];
}

function isFactory(value: unknown): value is AnyFactory {
  return typeof value === "object" && value !== null && FACTORY in value;
}

export type StateFn = (attrs: Attrs, ctx: ResolveContext) => Attrs;
export type StateMap = Record<string, (...args: never[]) => Attrs | StateFn>;

interface Step {
  kind: "state" | "sequence" | "relation";
  apply: (attrs: Attrs, ctx: ResolveContext, run: RunContext) => void;
}

interface Config {
  client: Record<string, unknown>;
  modelKey: string;
  define: (ctx: ResolveContext) => Attrs;
  identify: (row: Attrs) => Attrs;
  steps: Step[];
  count: number;
  /** Whether `make`/`create` return arrays. Set by `count()`, independent of the count value. */
  many: boolean;
  afterMaking: ((data: Attrs) => void)[];
  afterCreating: ((row: never) => void | Promise<void>)[];
  seqCounter: { value: number };
}

/**
 * Expand lazy values and nested factories, in declaration order, Laravel-style.
 *
 * A value that is a factory for `parentModel` is dropped: this factory is being nested
 * underneath that parent, so Prisma's nested input already implies the back-reference
 * and would reject the field.
 */
function expand(raw: Attrs, ctx: ResolveContext, run: RunContext, parentModel?: string): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (parentModel !== undefined && isFactory(value) && value.modelKey === parentModel) continue;
    out[key] = expandValue(value, out, ctx, run);
  }
  return out;
}

function expandValue(value: unknown, soFar: Attrs, ctx: ResolveContext, run: RunContext): unknown {
  if (typeof value === "function") {
    return expandValue((value as (a: Attrs, c: ResolveContext) => unknown)(soFar, ctx), soFar, ctx, run);
  }
  if (isFactory(value)) {
    return nestedWrite(value, run);
  }
  return value;
}

/** Turn a nested factory into a Prisma nested-write payload, honouring the recycle pool. */
function nestedWrite(factory: AnyFactory, run: RunContext, parentModel?: string): Attrs {
  const pool = run.recycled.get(factory.modelKey);
  if (pool && pool.length > 0) {
    const picked = pool[Math.floor(Math.random() * pool.length)] as Attrs;
    return { connect: factory.identify(picked) };
  }
  const rows = factory.resolveMany(run, parentModel);
  return { create: rows.length === 1 ? (rows[0] as Attrs) : rows };
}

function build(config: Config): unknown {
  const self = {
    [FACTORY]: true as const,
    modelKey: config.modelKey,

    identify(row: Attrs) {
      return config.identify(row);
    },

    /** Resolve `count` attribute sets without touching the database. */
    resolveMany(run: RunContext, parentModel?: string): Attrs[] {
      const results: Attrs[] = [];
      for (let index = 0; index < config.count; index++) {
        const ctx: ResolveContext = { index, seq: ++config.seqCounter.value };
        const raw: Attrs = { ...config.define(ctx) };
        for (const step of config.steps) step.apply(raw, ctx, run);
        const data = expand(raw, ctx, run, parentModel);
        for (const hook of config.afterMaking) hook(data);
        results.push(data);
      }
      return results;
    },

    async runAfterCreating(row: unknown): Promise<void> {
      for (const hook of config.afterCreating) await hook(row as never);
    },

    count(n: number) {
      return build({ ...config, count: n, many: true });
    },

    state(patch: Attrs | StateFn) {
      return build({
        ...config,
        steps: [
          ...config.steps,
          {
            kind: "state",
            apply: (attrs, ctx) => {
              Object.assign(attrs, typeof patch === "function" ? patch(attrs, ctx) : patch);
            },
          },
        ],
      });
    },

    sequence(...entries: (Attrs | StateFn)[]) {
      return build({
        ...config,
        steps: [
          ...config.steps,
          {
            kind: "sequence",
            apply: (attrs, ctx) => {
              const entry = entries[ctx.index % entries.length];
              Object.assign(attrs, typeof entry === "function" ? entry(attrs, ctx) : entry);
            },
          },
        ],
      });
    },

    /** Attach a relation as a Prisma nested write. Accepts a factory or a raw nested payload. */
    with(field: string, spec: unknown) {
      return build({
        ...config,
        steps: [
          ...config.steps,
          {
            kind: "relation",
            apply: (attrs, _ctx, run) => {
              attrs[field] = isFactory(spec) ? nestedWrite(spec, run, config.modelKey) : spec;
            },
          },
        ],
      });
    },

    /** Reuse the given rows for any nested factory targeting the same model. */
    recycle(modelKey: string, rows: Attrs | Attrs[]) {
      const list = Array.isArray(rows) ? rows : [rows];
      return build({
        ...config,
        steps: [
          ...config.steps,
          {
            kind: "relation",
            apply: (_attrs, _ctx, run) => {
              run.recycled.set(modelKey, list);
            },
          },
        ],
      });
    },

    afterMaking(hook: (data: Attrs) => void) {
      return build({ ...config, afterMaking: [...config.afterMaking, hook] });
    },

    afterCreating(hook: (row: never) => void | Promise<void>) {
      return build({ ...config, afterCreating: [...config.afterCreating, hook] });
    },

    make(overrides?: Attrs) {
      const run: RunContext = { recycled: new Map(), afterCreating: [] };
      const rows = self.resolveMany(run).map((r) => ({ ...r, ...overrides }));
      return config.many ? rows : rows[0];
    },

    async create(overrides?: Attrs) {
      const run: RunContext = { recycled: new Map(), afterCreating: [] };
      const rows = self.resolveMany(run).map((r) => ({ ...r, ...overrides }));
      const delegate = config.client[config.modelKey] as {
        create: (args: { data: Attrs }) => Promise<Attrs>;
      };
      const created: Attrs[] = [];
      for (const data of rows) created.push(await delegate.create({ data }));
      for (const row of created) await self.runAfterCreating(row);
      return config.many ? created : created[0];
    },
  };

  return self;
}

export { build as buildFactory, FACTORY, isFactory };
export type { AnyFactory, Attrs, Cardinality, Config, RunContext };
export type { CreateInput, Model, ModelKey, RelationKey, Resolvable, WhereUnique };
