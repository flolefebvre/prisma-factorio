import { createFakerProvider, type FakerOptions } from "./faker.js";
import {
  createFactory,
  declaredStates,
  type DeclaredStates,
  type Factory,
  type FactoryConfig,
  type StateMap,
} from "./factory.js";
import type { ModelName, Row } from "./prisma.js";

/**
 * The entry point a bootstrap hands back, bound to one client and one faker.
 *
 * @example
 * ```ts
 * const f: Factorio<PrismaClient> = initPrismaFactorio(prisma);
 * const users = f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
 * ```
 */
export interface Factorio<C> {
  define<M extends ModelName<C>, D, S extends StateMap<C, M> & DeclaredStates<C, M, S> = Record<never, never>>(
    model: M,
    config: FactoryConfig<C, M, D, S>,
  ): Factory<C, M, Row<C, M>, S>;
}

function resolver<C extends object>(source: C | (() => C)): () => C {
  const thunk = typeof source === "function" ? source : (): C => source;
  let client: C | undefined;

  return () => (client ??= thunk());
}

/**
 * Binds the factory API to a Prisma client.
 *
 * The client may be a thunk, which is called on the first `create` and never again: importing a
 * module that declares factories then costs nothing, and a test may replace the client beforehand.
 * `seed` and `locale` configure the one faker every definition of this bootstrap reads.
 *
 * @example
 * ```ts
 * const f = initPrismaFactorio(() => prisma, { seed: 1234, locale: "fr" });
 * const users = f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
 * const ada = await users.create({ name: "Ada" });
 * ```
 */
export function initPrismaFactorio<C extends object>(
  clientOrThunk: C | (() => C),
  options: FakerOptions = {},
): Factorio<C> {
  const faker = createFakerProvider(options);
  const client = resolver(clientOrThunk);

  const define: Factorio<C>["define"] = (model, config) =>
    createFactory({
      model,
      definition: config.definition,
      declared: declaredStates(config.states),
      applied: [],
      client,
      faker,
      batch: undefined,
    });

  return { define };
}
