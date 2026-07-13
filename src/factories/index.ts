// Runtime machinery imported by generated code via "prisma-factorio/factories".

/**
 * Base class of every generated model factory. The generator emits one
 * subclass per model, pinned to the model's Prisma `CreateInput` type, and
 * user code extends that subclass with a {@link Factory.definition}.
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
 * const input = UserFactory.new().make();
 */
export abstract class Factory<TCreateInput> {
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
  static new<TFactory extends Factory<unknown>>(this: new () => TFactory): TFactory {
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
}
