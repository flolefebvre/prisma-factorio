// Runtime machinery imported by generated code via "prisma-factorio/factories".

/**
 * A Prisma client instance, or a getter returning one. A getter is invoked
 * freshly on every {@link Factory.create} call, so the client may be swapped
 * or constructed lazily after registration. The typed `initPrismaFactorio`
 * wrapper in the generated barrel accepts the same two shapes, narrowed to
 * the client generated for your schema.
 *
 * @example
 * initPrismaFactorio({ prisma: () => currentTestPrisma });
 */
export type PrismaClientSource = object | (() => object);

/**
 * Options of {@link initPrismaFactorio}. Prefer the typed wrapper in the
 * generated barrel, which narrows `prisma` to your schema's `PrismaClient`.
 *
 * @example
 * const options: InitPrismaFactorioOptions = { prisma: new PrismaClient({ adapter }) };
 */
export interface InitPrismaFactorioOptions {
  prisma: PrismaClientSource;
}

let registeredClientSource: PrismaClientSource | undefined;

/**
 * Registers the Prisma client that {@link Factory.create} persists through.
 * Call it once at startup, before the first `create()`. Calling it again
 * replaces the previous registration (last wins).
 *
 * The default way to init is the typed wrapper of the same name in the
 * generated barrel, which pins `prisma` to the client generated for your
 * schema. This untyped runtime function is the escape hatch for clients the
 * generated type would reject, such as mocks or partial clients.
 *
 * @example
 * // Default path: the typed wrapper emitted next to the generated factories.
 * import { initPrismaFactorio } from "./generated/prisma-factorio/index.ts";
 * initPrismaFactorio({ prisma: new PrismaClient({ adapter }) });
 *
 * @example
 * // Escape hatch: register a hand-rolled partial client for a unit test.
 * import { initPrismaFactorio } from "prisma-factorio/factories";
 * initPrismaFactorio({ prisma: { user: { create: async () => stubUser } } });
 */
export function initPrismaFactorio(options: InitPrismaFactorioOptions): void {
  registeredClientSource = options.prisma;
}

/**
 * Rejection of {@link Factory.create} when no usable Prisma client is
 * available: {@link initPrismaFactorio} was never called, or the registered
 * getter returned undefined because the client was not yet constructed.
 *
 * @example
 * await expect(UserFactory.new().create()).rejects.toBeInstanceOf(PrismaFactorioNotInitializedError);
 */
export class PrismaFactorioNotInitializedError extends Error {
  constructor(message = "No Prisma client is registered. Call initPrismaFactorio({ prisma }) before create().") {
    super(message);
    this.name = "PrismaFactorioNotInitializedError";
  }
}

/**
 * What {@link Factory.state} (and the overrides argument of
 * {@link Factory.make} / {@link Factory.create}) accepts: a partial of the
 * model's `CreateInput`, or a closure computing one from the attributes
 * evaluated so far in the chain (definition plus earlier states).
 *
 * @example
 * UserFactory.new().state({ name: "Abigail Otwell" });
 * UserFactory.new().state((attrs) => ({ email: `${attrs.name}@example.com` }));
 */
export type StateInput<TCreateInput> = Partial<TCreateInput> | ((attributes: TCreateInput) => Partial<TCreateInput>);

function isStateClosure<TCreateInput>(
  input: StateInput<TCreateInput>,
): input is (attributes: TCreateInput) => Partial<TCreateInput> {
  return typeof input === "function";
}

/**
 * What {@link Factory.sequence} accepts: one or more partials cycled over by
 * instance index, or a single closure computing the partial from the 0-based
 * index. Sequence says what varies per instance; it never sets how many
 * instances there are — that is {@link Factory.count}.
 *
 * @example
 * UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" });
 * UserFactory.new().count(10).sequence((i) => ({ name: `User ${i}` }));
 */
export type SequenceInput<TCreateInput> =
  readonly [Partial<TCreateInput>, ...Partial<TCreateInput>[]] | readonly [(index: number) => Partial<TCreateInput>];

// Declared with method syntax so the attributes parameter checks bivariantly:
// a bare function type would make `states` contravariant in TCreateInput and
// concrete factories would stop satisfying the Factory<unknown, unknown>
// constraint of Factory.new().
type PipelineStep<TCreateInput> = {
  step(attributes: TCreateInput, index: number): Partial<TCreateInput>;
}["step"];

function toPipelineStep<TCreateInput>(input: StateInput<TCreateInput>): PipelineStep<TCreateInput> {
  return (attributes) => (isStateClosure(input) ? input(attributes) : input);
}

function sequenceStepAt<TCreateInput>(steps: SequenceInput<TCreateInput>): (index: number) => Partial<TCreateInput> {
  const [first] = steps;
  if (typeof first === "function") {
    return first;
  }
  const values = steps as readonly Partial<TCreateInput>[];
  return (index) => values[index % values.length] ?? {};
}

function assertZeroArgConstructor(ctor: new () => unknown): void {
  // A bare construct-signature type does not structurally carry Function's
  // length/name, so reading them is the single untyped boundary here. `length`
  // counts exactly the required parameters — default and rest parameters do
  // not add to it.
  const fn = ctor as unknown as { length: number; name: string };
  if (fn.length > 0) {
    throw new TypeError(
      `${fn.name} declares ${String(fn.length)} required constructor parameter(s). Factory chains fork by fresh construction, so factory classes must be constructible with no arguments — pin per-factory values with class fields or named states instead.`,
    );
  }
}

interface DelegateLike<TModel> {
  create(args: { data: unknown }): Promise<TModel>;
}

function isClientGetter(source: PrismaClientSource): source is () => object {
  return typeof source === "function";
}

function resolveClient(): object {
  if (registeredClientSource === undefined) {
    throw new PrismaFactorioNotInitializedError();
  }
  if (!isClientGetter(registeredClientSource)) {
    return registeredClientSource;
  }
  // A getter typed with a non-null assertion (`let client!: PrismaClient`)
  // can still yield nullish at runtime when create() runs before the client
  // is assigned; without this guard that surfaces as an opaque TypeError.
  const client = registeredClientSource() as object | null | undefined;
  if (client === undefined || client === null) {
    throw new PrismaFactorioNotInitializedError(
      "The registered Prisma client getter returned undefined — the client was not yet constructed when create() ran.",
    );
  }
  return client;
}

/**
 * Base class of every generated model factory. The generator emits one
 * subclass per model, pinned to the model's Prisma `CreateInput` and model
 * types, and user code extends that subclass with a {@link Factory.definition}.
 *
 * Instances are immutable: no method mutates the factory, so chain steps
 * like {@link Factory.state} return copies instead of modifying `this`.
 *
 * Subclasses must be constructible with no arguments and hold no mutable
 * per-instance state: a chain step forks by fresh construction, so only the
 * pipeline carries over — anything set through a constructor parameter is lost
 * on the first fork. Pin per-factory values with class field initializers or
 * named states instead. A required constructor parameter throws a `TypeError`
 * at the first fork rather than silently producing wrong data.
 *
 * @example
 * class UserFactory extends UserFactoryBase {
 *   definition() {
 *     return { email: "ada@example.com", role: Role.ADMIN };
 *   }
 * }
 * const user = await UserFactory.new().create();
 */
export abstract class Factory<TCreateInput, TModel> {
  /**
   * Name of the Prisma client delegate {@link Factory.create} persists
   * through — the model name with its first letter lowercased. Baked into
   * every generated base class because the schema is unavailable at runtime.
   *
   * @example
   * protected readonly prismaDelegate = "user";
   */
  protected abstract readonly prismaDelegate: string;

  private states: readonly PipelineStep<TCreateInput>[] = [];

  /**
   * Declares the default attributes of the model. Called once per
   * {@link Factory.make}, so values are computed fresh for every record.
   *
   * @example
   * definition() {
   *   return { email: `user-${crypto.randomUUID()}@example.com`, role: Role.MEMBER };
   * }
   */
  abstract definition(): TCreateInput;

  /**
   * Creates a factory instance; the entry point of every factory chain.
   *
   * @example
   * const factory = UserFactory.new();
   */
  static new<TFactory extends Factory<unknown, unknown>>(this: new () => TFactory): TFactory {
    assertZeroArgConstructor(this);
    return new this();
  }

  /**
   * Appends a state to the chain and returns a copy of the factory; the
   * receiver is untouched. Nothing evaluates until {@link Factory.make} or
   * {@link Factory.create}. Named states are this same method called from a
   * factory method; inline call-site states call it directly.
   *
   * @example
   * // Named state in a factory class:
   * suspended() {
   *   return this.state({ status: "suspended" });
   * }
   * @example
   * // Inline at the call site, closure form reading earlier attributes:
   * UserFactory.new().state({ name: "Ada" }).state((attrs) => ({ email: `${attrs.name}@example.com` }));
   */
  state(input: StateInput<TCreateInput>): this {
    return this.fork(toPipelineStep(input));
  }

  /**
   * Appends a cyclic, index-driven state at this chain position and returns a
   * copy of the factory. Partials are cycled over the 0-based instance index
   * (`index % values.length`); the closure form computes the partial from that
   * index. Sequence never sets how many instances there are: without
   * {@link Factory.count} a single instance is built and only the first value
   * is used.
   *
   * @example
   * // 5 admins, 5 members:
   * await UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" }).create();
   * @example
   * await UserFactory.new().count(10).sequence((i) => ({ name: `User ${String(i)}` })).create();
   */
  sequence(step: (index: number) => Partial<TCreateInput>): this;
  sequence(...values: [Partial<TCreateInput>, ...Partial<TCreateInput>[]]): this;
  sequence(...steps: SequenceInput<TCreateInput>): this {
    const stepAt = sequenceStepAt(steps);
    return this.fork((_attributes, index) => stepAt(index));
  }

  private fork(step: PipelineStep<TCreateInput>): this {
    // Fresh construction installs subclass class fields on the copy itself —
    // arrow-function named states stay bound to the copy and native #private
    // fields keep working. `states` is the only field to carry over: bulk-
    // assigning the rest would copy arrow fields still bound to the receiver.
    // Fresh construction only holds when the subclass takes no constructor
    // arguments, so the guard fires here, the first moment a fork happens.
    const ctor = this.constructor as new () => this;
    assertZeroArgConstructor(ctor);
    const copy = new ctor();
    copy.states = [...this.states, step];
    return copy;
  }

  /**
   * Builds the model's `CreateInput` synchronously by running the whole
   * pipeline: {@link Factory.definition} first, then states in chain order,
   * then `overrides` last — shallow merge, last value wins per field.
   * Everything, definition included, is re-evaluated on each call.
   *
   * @example
   * const input = UserFactory.new().suspended().make({ name: "Ada" });
   */
  make(overrides?: StateInput<TCreateInput>): TCreateInput {
    return this.makeAt(0, overrides);
  }

  private makeAt(index: number, overrides?: StateInput<TCreateInput>): TCreateInput {
    const pipeline = overrides === undefined ? this.states : [...this.states, toPipelineStep(overrides)];
    return pipeline.reduce<TCreateInput>(
      (attributes, step) => ({ ...attributes, ...step(attributes, index) }),
      this.definition(),
    );
  }

  /**
   * Sets how many instances the factory produces and flips the chain to the
   * list-typed {@link ListFactory}: `make()` returns `TCreateInput[]` and
   * `create()` resolves `TModel[]`. Count says how many, never what varies —
   * pair it with {@link Factory.sequence} for per-instance variation. The
   * receiver is untouched; `n` must be a non-negative integer.
   *
   * @example
   * const users = await UserFactory.new().count(3).create(); // User[]
   */
  count(n: number): ListFactory<TCreateInput, TModel> {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`count() needs a non-negative integer, got ${String(n)}.`);
    }
    // The bound builders carry the private per-index pipeline into the list
    // factory without widening the visibility of makeAt/createAt.
    return new ListFactory(
      this,
      n,
      (index, overrides) => this.makeAt(index, overrides),
      (index, overrides) => this.createAt(index, overrides),
    );
  }

  /**
   * Persists one record through the Prisma client registered with
   * {@link initPrismaFactorio} and resolves with the persisted row. The
   * `overrides` argument is applied as a final state, exactly as
   * `.state(overrides).create()`.
   *
   * @example
   * const user = await UserFactory.new().create({ name: "Abigail" }); // row persisted via prisma.user.create
   */
  async create(overrides?: StateInput<TCreateInput>): Promise<TModel> {
    return this.createAt(0, overrides);
  }

  private async createAt(index: number, overrides?: StateInput<TCreateInput>): Promise<TModel> {
    // The registry cannot carry concrete client types; the generated base
    // pins prismaDelegate and TModel to the same model, so this single cast
    // is the whole untyped boundary.
    const delegates = resolveClient() as Record<string, DelegateLike<TModel> | undefined>;
    const delegate = delegates[this.prismaDelegate];
    if (delegate === undefined) {
      throw new TypeError(
        `The registered Prisma client has no "${this.prismaDelegate}" delegate; pass the client generated for this schema to initPrismaFactorio.`,
      );
    }
    return delegate.create({ data: this.makeAt(index, overrides) });
  }
}

/**
 * A factory chain that produces a fixed number of instances; entered through
 * {@link Factory.count}, never constructed directly. The chain primitives keep
 * working at their position — each returns a new list factory over a forked
 * copy of the underlying factory, so immutability holds — and `make()` /
 * `create()` produce lists instead of single values.
 *
 * @example
 * const users = await UserFactory.new().count(3).create(); // User[]
 */
export class ListFactory<TCreateInput, TModel> {
  constructor(
    private readonly factory: Factory<TCreateInput, TModel>,
    private readonly instances: number,
    private readonly makeAt: (index: number, overrides?: StateInput<TCreateInput>) => TCreateInput,
    private readonly createAt: (index: number, overrides?: StateInput<TCreateInput>) => Promise<TModel>,
  ) {}

  /**
   * Replaces how many instances the chain produces — the last count wins.
   *
   * @example
   * UserFactory.new().count(5).count(2).make(); // 2 inputs
   */
  count(n: number): ListFactory<TCreateInput, TModel> {
    return this.factory.count(n);
  }

  /**
   * Appends a state at this chain position, exactly like {@link Factory.state},
   * keeping the instance count.
   *
   * @example
   * UserFactory.new().count(3).state({ role: "admin" }).make();
   */
  state(input: StateInput<TCreateInput>): ListFactory<TCreateInput, TModel> {
    return this.factory.state(input).count(this.instances);
  }

  /**
   * Appends a cyclic, index-driven state at this chain position, exactly like
   * {@link Factory.sequence}, keeping the instance count.
   *
   * @example
   * UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" }).make();
   */
  sequence(step: (index: number) => Partial<TCreateInput>): ListFactory<TCreateInput, TModel>;
  sequence(...values: [Partial<TCreateInput>, ...Partial<TCreateInput>[]]): ListFactory<TCreateInput, TModel>;
  sequence(...steps: SequenceInput<TCreateInput>): ListFactory<TCreateInput, TModel> {
    return this.factory.sequence(sequenceStepAt(steps)).count(this.instances);
  }

  /**
   * Builds one `CreateInput` per instance. The whole pipeline — definition,
   * states, `overrides` — is re-evaluated for each instance, so random values
   * differ across the list.
   *
   * @example
   * const inputs = UserFactory.new().count(3).make(); // UserCreateInput[]
   */
  make(overrides?: StateInput<TCreateInput>): TCreateInput[] {
    return Array.from({ length: this.instances }, (_, index) => this.makeAt(index, overrides));
  }

  /**
   * Persists one record per instance through n individual `create` calls, run
   * sequentially, and resolves with the rows in creation order. The calls are
   * not wrapped in a transaction — a mid-batch failure leaves the earlier rows
   * persisted; wrap the call in `$transaction` yourself when that matters.
   *
   * @example
   * const users = await prisma.$transaction(() => UserFactory.new().count(3).create());
   */
  async create(overrides?: StateInput<TCreateInput>): Promise<TModel[]> {
    const rows: TModel[] = [];
    for (let index = 0; index < this.instances; index += 1) {
      rows.push(await this.createAt(index, overrides));
    }
    return rows;
  }
}
