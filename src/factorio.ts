import { createFakerProvider, type FactorioOptions } from "./faker.js";
import {
  createFactory,
  declaredStates,
  type DeclaredStates,
  type Factory,
  type FactoryConfig,
  type StateMap,
} from "./factory.js";
import type { ModelName, Row } from "./prisma.js";
import { createReseedablePicker } from "./rng.js";

/**
 * The entry point a bootstrap hands back, bound to one client and one faker.
 *
 * @example
 * ```ts
 * const prismaFactorio: Factorio<PrismaClient> = initPrismaFactorio(prisma);
 * const userFactory = prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
 * ```
 */
export interface Factorio<C> {
  define<M extends ModelName<C>, D, S extends StateMap<C, M> & DeclaredStates<C, M, S> = Record<never, never>>(
    model: M,
    config: FactoryConfig<C, M, D, S>,
  ): Factory<C, M, Row<C, M>, S>;

  /**
   * Restarts this bootstrap's faker and its recycle picks on a new seed, for every factory it has
   * defined and every factory it defines after.
   *
   * From then on, faker's values and the rows recycle pools pick are those of a fresh bootstrap seeded
   * `seed` running the same calls; without a seed, both are reseeded at random, as an unseeded bootstrap
   * is. `uid` is not pinned. Call it between creates: a reseed while a `create()` is in flight leaves
   * that create's draws unspecified.
   *
   * @example
   * ```ts
   * registerResetHook(({ seed }) => prismaFactorio.reseed(seed));
   * ```
   */
  reseed(seed?: number): void;
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
 * `locale` configures the one faker every definition of this bootstrap reads, and `seed` pins both
 * the values that faker generates and the rows a recycle pool picks. The picks belong to the graph
 * that resolves them rather than to the bootstrap that defined the factory, so a factory defined here
 * and reached through a graph of another bootstrap draws from that one's stream, seeded or not.
 * `reseed` restarts both on a new seed between creates, so a test harness can hand every factory a
 * seed of its own per test.
 *
 * @example
 * ```ts
 * const prismaFactorio = initPrismaFactorio(() => prisma, { seed: 1234, locale: "fr" });
 * const userFactory = prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
 * const ada = await userFactory.create({ name: "Ada" });
 * ```
 */
export function initPrismaFactorio<C extends object>(
  clientOrThunk: C | (() => C),
  options: FactorioOptions = {},
): Factorio<C> {
  const faker = createFakerProvider(options);
  // One picker per bootstrap, so every factory it defines draws its recycled rows from one stream.
  const { pick, reseed: reseedPicks } = createReseedablePicker(options.seed);
  const client = resolver(clientOrThunk);

  const define: Factorio<C>["define"] = (model, config) =>
    createFactory({
      model,
      definition: config.definition,
      declared: declaredStates(config.states),
      applied: [],
      callbacks: config.afterCreating === undefined ? [] : [config.afterCreating],
      client,
      explicit: false,
      faker,
      batch: undefined,
      parent: undefined,
      pool: {},
      pick,
    });

  const reseed: Factorio<C>["reseed"] = (seed) => {
    faker.reseed(seed);
    reseedPicks(seed);
  };

  return { define, reseed };
}
