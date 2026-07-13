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
 * Instances are immutable: no method mutates the factory, so future chain
 * steps return copies instead of modifying `this`.
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
   * Builds the model's `CreateInput` synchronously, re-evaluating
   * {@link Factory.definition} on each call.
   *
   * @example
   * const input = UserFactory.new().make(); // { email: "...", role: "MEMBER" }
   */
  make(): TCreateInput {
    return this.definition();
  }

  /**
   * Persists one record through the Prisma client registered with
   * {@link initPrismaFactorio} and resolves with the persisted row.
   *
   * @example
   * const user = await UserFactory.new().create(); // row persisted via prisma.user.create
   */
  async create(): Promise<TModel> {
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
    return delegate.create({ data: this.make() });
  }
}
