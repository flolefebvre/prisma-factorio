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

  private states: readonly StateInput<TCreateInput>[] = [];

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
    // Fresh construction installs subclass class fields on the copy itself —
    // arrow-function named states stay bound to the copy and native #private
    // fields keep working. `states` is the only field to carry over: bulk-
    // assigning the rest would copy arrow fields still bound to the receiver.
    const copy = new (this.constructor as new () => this)();
    copy.states = [...this.states, input];
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
    const pipeline = overrides === undefined ? this.states : [...this.states, overrides];
    return pipeline.reduce<TCreateInput>(
      (attributes, state) => ({ ...attributes, ...(isStateClosure(state) ? state(attributes) : state) }),
      this.definition(),
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
    return delegate.create({ data: this.make(overrides) });
  }
}
