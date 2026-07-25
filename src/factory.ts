import type { FakerInstance, FakerProvider } from "./faker.js";
import type { Attributes, CreateInput, ModelName, Overrides, Row } from "./prisma.js";
import { nextUid } from "./uid.js";

/**
 * What a definition is handed to build one record.
 *
 * @example
 * ```ts
 * const definition = ({ faker, index, uid }: EvaluationContext) => ({
 *   email: `${uid}@example.com`,
 *   name: index === 0 ? "Ada" : faker.person.fullName(),
 * });
 * ```
 */
export interface EvaluationContext {
  faker: FakerInstance;
  index: number;
  uid: string;
}

/**
 * How a factory is declared.
 *
 * @example
 * ```ts
 * const config: FactoryConfig<PrismaClient, "user"> = {
 *   definition: ({ uid }) => ({ email: `${uid}@example.com` }),
 * };
 * ```
 */
export interface FactoryConfig<C, M extends ModelName<C>, D = CreateInput<C, M>> {
  definition: (context: EvaluationContext) => Attributes<C, M, D>;
}

/**
 * A factory bound to one model. Every call returns a new factory, leaving the receiver untouched.
 *
 * `count` takes a non-negative whole number and throws a `RangeError` on anything else; `count(0)`
 * is legal and creates no records.
 *
 * @example
 * ```ts
 * const admins = users.count(3);
 * const rows = await admins.using(tx).create({ name: "Ada" });
 * ```
 */
export interface Factory<C, M extends ModelName<C>, R = Row<C, M>> {
  create<O>(overrides?: Overrides<C, M, O>): Promise<R>;
  count(records: number): Factory<C, M, Row<C, M>[]>;
  using(client: Pick<C, M>): Factory<C, M, R>;
}

type Written = Record<string, unknown>;

interface CreateDelegate {
  create(args: { data: Written }): Promise<unknown>;
}

interface FactoryState<C, M extends ModelName<C>> {
  model: M;
  definition: (context: EvaluationContext) => Written;
  client: () => Pick<C, M>;
  faker: FakerProvider;
  batch: number | undefined;
}

async function write<C, M extends ModelName<C>>(
  state: FactoryState<C, M>,
  overrides: Written | undefined,
): Promise<unknown[]> {
  // One faker serves the whole batch, so a seeded run replays the same values in the same order.
  const faker = await state.faker();
  const delegate = state.client()[state.model] as CreateDelegate;
  const rows: unknown[] = [];

  for (let index = 0; index < (state.batch ?? 1); index += 1) {
    const attributes = state.definition({ faker, index, uid: nextUid() });
    rows.push(await delegate.create({ data: { ...attributes, ...overrides } }));
  }

  return rows;
}

/**
 * Builds a factory over the state a chain has accumulated.
 *
 * @example
 * ```ts
 * const users = createFactory<PrismaClient, "user", Row<PrismaClient, "user">>(state);
 * ```
 */
export function createFactory<C, M extends ModelName<C>, R>(state: FactoryState<C, M>): Factory<C, M, R> {
  return {
    async create<O>(overrides?: Overrides<C, M, O>): Promise<R> {
      const rows = await write(state, overrides as Written | undefined);
      return (state.batch === undefined ? rows[0] : rows) as R;
    },
    count(records: number): Factory<C, M, Row<C, M>[]> {
      if (!Number.isInteger(records) || records < 0)
        throw new RangeError(`count(${String(records)}) is not a batch size. Pass a non-negative whole number.`);

      return createFactory({ ...state, batch: records });
    },
    using(client: Pick<C, M>): Factory<C, M, R> {
      return createFactory({ ...state, client: () => client });
    },
  };
}
