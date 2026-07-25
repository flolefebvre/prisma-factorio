import type { AnyFactory, Definition, EmptyInclude, Factory, StateMap } from "./factory.ts";
import { REF } from "./markers.ts";
import type { RefMarker } from "./markers.ts";
import type { ModelName } from "./types.ts";
import type { ScopeOptions } from "./runtime.ts";
import { createScope } from "./runtime.ts";

export { cycle, lazy } from "./markers.ts";
export type { Factory } from "./factory.ts";
export type { FieldContext } from "./markers.ts";
export type { ScopeOptions } from "./runtime.ts";

/**
 * Everything a set of factories shares: the client they write through, the
 * sequence counter, and the model lookup that lets definitions reference one
 * another before they are all declared.
 */
export interface Scope<C> {
  /**
   * Declares the default attributes and named states for one model.
   *
   * @example
   * ```ts
   * const user = define("user", {
   *   fields: { name: "Ada", email: lazy(({ seq }) => `ada-${seq}@example.com`) },
   *   states: { admin: { role: "admin" } },
   * });
   * ```
   */
  define: <M extends ModelName<C>, S extends StateMap<C, M>>(
    model: M,
    definition: Definition<C, M, S>,
  ) => Factory<C, M, S, EmptyInclude, "one">;

  /**
   * References another model's factory by name, so definitions may point at
   * each other in any order, including cycles.
   *
   * @example
   * ```ts
   * const post = define("post", { fields: { title: "Hi", author: use("user") } });
   * ```
   */
  use: <M extends ModelName<C>>(model: M) => AnyFactory<C, M>;

  /** Runs `body` with every factory in this scope bound to `client`. */
  withClient: <T>(client: C, body: () => Promise<T>) => Promise<T>;

  /** Restarts the counter handed to `lazy(({ seq }) => …)`. */
  resetSequence: () => void;
}

/**
 * Opens a factory scope over a Prisma client.
 *
 * @example
 * ```ts
 * const { define, use } = factoryScope(prisma);
 * const user = define("user", { fields: { name: "Ada", email: "ada@example.com" } });
 * const ada = await user.create();
 * ```
 */
export const factoryScope = <C extends object>(client: C, options: ScopeOptions = {}): Scope<C> => {
  const scope = createScope(client, options);
  return {
    define: ((model: string, definition: unknown) =>
      scope.define(model, definition as never)) as unknown as Scope<C>["define"],
    use: <M extends ModelName<C>>(model: M) => ({ [REF]: model }) as RefMarker as unknown as AnyFactory<C, M>,
    withClient: (bound, body) => scope.withClient(bound, body),
    resetSequence: () => {
      scope.seq.value = 0;
    },
  };
};
