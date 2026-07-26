import type { Faker } from "@faker-js/faker";

/**
 * The faker handed to a definition through its evaluation context.
 *
 * @example
 * ```ts
 * const displayName = (faker: FakerInstance) => faker.person.fullName();
 * ```
 */
export type FakerInstance = Faker;

/**
 * How a bootstrap is configured, the faker it hands out and the picks it replays alike.
 *
 * `locale` is one of the locale names `@faker-js/faker` exports, such as `"en"`, `"fr"` or
 * `"de_AT"`.
 *
 * @example
 * ```ts
 * const options: FactorioOptions = { seed: 1234, locale: "fr" };
 * ```
 */
export interface FactorioOptions {
  /**
   * Pins every value a bootstrap draws at random: the output faker generates, and the rows a recycle
   * pool picks. Each is a stream of its own, so one seed replays both, and neither moves the other
   * along. It does not make a run reproducible on its own, since a uid draws a fresh prefix in every
   * process.
   *
   * @example
   * ```ts
   * const prismaFactorio = initPrismaFactorio(prisma, { seed: 1234 });
   * ```
   */
  seed?: number | undefined;
  locale?: string | undefined;
}

/**
 * Hands out the one faker instance a bootstrap is configured for.
 *
 * @example
 * ```ts
 * const faker = await provider();
 * ```
 */
export type FakerProvider = () => Promise<FakerInstance>;

/**
 * Builds a provider that resolves `@faker-js/faker` on first use and reuses that instance after.
 *
 * `@faker-js/faker` is an optional peer dependency, so the import is deferred to the first call
 * rather than taken at module load. When it cannot be loaded the provider still resolves, with a
 * stand-in that throws the moment a definition reads a generator off it — a definition that never
 * mentions faker therefore runs without the package installed.
 *
 * @example
 * ```ts
 * const provider = createFakerProvider({ seed: 1234, locale: "fr" });
 * const faker = await provider();
 * faker.location.city(); // "Bordeaux"
 * ```
 */
export function createFakerProvider(options: FactorioOptions = {}): FakerProvider {
  let resolution: Promise<FakerInstance> | undefined;

  return () =>
    (resolution ??= import("@faker-js/faker").then(
      (module) => configure(module, options),
      (cause: unknown) => unavailableFaker(cause),
    ));
}

type FakerModule = typeof import("@faker-js/faker");

function configure({ Faker: FakerClass, allLocales }: FakerModule, { seed, locale }: FactorioOptions): FakerInstance {
  // Every locale definition but `en` is partial, so a category it leaves out falls through to `en`
  // and then to the language-neutral `base`.
  const fallback = [allLocales.en, allLocales.base];
  const requested = locale === undefined ? undefined : new Map(Object.entries(allLocales)).get(locale);

  if (locale !== undefined && requested === undefined) {
    throw new Error(
      `Unknown faker locale "${locale}". Pass one of the locale names @faker-js/faker exports, such as "en", "fr" or "de_AT".`,
    );
  }

  const faker = new FakerClass({ locale: requested === undefined ? fallback : [requested, ...fallback] });

  if (seed !== undefined) faker.seed(seed);

  return faker;
}

// A host may probe the stand-in before any definition reads a generator off it: the promise it is
// resolved with tests `then`, and printers and serialisers reach for `toJSON`, for the well-known
// symbols and for what `Object.prototype` carries. Those probes stay inert; everything else throws.
const INERT: ReadonlySet<PropertyKey> = new Set(["then", "toJSON"]);

function unavailableFaker(cause: unknown): FakerInstance {
  return new Proxy(
    {},
    {
      get(target, property, receiver) {
        if (typeof property === "symbol" || property in target)
          return Reflect.get(target, property, receiver) as unknown;
        if (INERT.has(property)) return undefined;

        throw new Error(
          `@faker-js/faker is not installed, so \`faker.${property}\` is unavailable. Install it (for example \`pnpm add -D @faker-js/faker\`), or write this definition without faker.`,
          { cause },
        );
      },
    },
  ) as FakerInstance;
}
