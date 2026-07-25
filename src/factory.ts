import type { FakerInstance, FakerProvider } from "./faker.js";
import type { Attributes, CreateInput, ModelName, Overrides, PartialAttributes, Row } from "./prisma.js";
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
 * What a state closure is handed, on top of everything a definition gets.
 *
 * `attrs` holds the attributes evaluated so far — the definition, then every state applied before
 * this one — and never carries a key whose value is `undefined`.
 *
 * @example
 * ```ts
 * const vip = ({ attrs, uid }: StateContext<PrismaClient, "user">) => ({
 *   email: `vip-${uid}@example.com`,
 *   name: attrs.name ?? "anonymous",
 * });
 * ```
 */
export interface StateContext<C, M extends ModelName<C>> extends EvaluationContext {
  attrs: PartialAttributes<C, M>;
  /** The row this record is created for; stays `undefined` until relation support lands. */
  parent: unknown;
}

/**
 * A state: the attributes to merge over what is evaluated so far, given outright or computed.
 *
 * @example
 * ```ts
 * const suspended: StateInput<PrismaClient, "user"> = { name: null };
 * const vip: StateInput<PrismaClient, "user"> = ({ uid }) => ({ email: `vip-${uid}@example.com` });
 * ```
 */
export type StateInput<C, M extends ModelName<C>> =
  PartialAttributes<C, M> | ((context: StateContext<C, M>) => PartialAttributes<C, M>);

// Assignability alone lets a state name a field the model does not declare: excess property
// checking reaches a fresh object literal only, never one held in a variable or returned from a
// block body. Routing both forms through `Overrides` closes that gap.
export type ExactState<C, M extends ModelName<C>, V> = V extends (context: StateContext<C, M>) => infer A
  ? (context: StateContext<C, M>) => Overrides<C, M, A>
  : Overrides<C, M, V>;

/**
 * The shape a factory's `states` takes before its keys are known.
 *
 * @example
 * ```ts
 * const states: StateMap<PrismaClient, "user"> = { suspended: { name: null } };
 * ```
 */
export type StateMap<C, M extends ModelName<C>> = Record<string, StateInput<C, M>>;

// A state is reached as a method, so one named after a method the factory already answers to would
// be unreachable. Every key here is also listed in `reservedNames`, which enforces the same rule at
// runtime for callers who compile nothing.
interface Reserved {
  create?: never;
  count?: never;
  using?: never;
  state?: never;
}

const reservedNames = ["create", "count", "using", "state"];

/**
 * What a factory's declared `states` must satisfy: every value exact, and no name the factory
 * already answers to.
 *
 * @example
 * ```ts
 * type Checked = DeclaredStates<PrismaClient, "user", { suspended: { name: null } }>;
 * ```
 */
export type DeclaredStates<C, M extends ModelName<C>, S> = Reserved & {
  [K in keyof S]: ExactState<C, M, S[K]>;
};

/**
 * How a factory is declared.
 *
 * @example
 * ```ts
 * const config: FactoryConfig<PrismaClient, "user"> = {
 *   definition: ({ uid }) => ({ email: `${uid}@example.com` }),
 *   states: { suspended: { name: null } },
 * };
 * ```
 */
export interface FactoryConfig<C, M extends ModelName<C>, D = CreateInput<C, M>, S = Record<never, never>> {
  definition: (context: EvaluationContext) => Attributes<C, M, D>;
  states?: S & StateMap<C, M>;
}

/**
 * Everything a factory answers to beyond the states its config declares.
 *
 * @example
 * ```ts
 * const rows = await users.count(3).state({ name: "Ada" }).create();
 * ```
 */
export interface FactoryMethods<C, M extends ModelName<C>, R, S> {
  create<O>(overrides?: Overrides<C, M, O>): Promise<R>;
  count(records: number): Factory<C, M, Row<C, M>[], S>;
  using(client: Pick<C, M>): Factory<C, M, R, S>;
  // One signature per form, rather than one parameter typed as `StateInput`: each form has to infer
  // the object it carries straight into `Overrides`, which is what makes a field the model does not
  // declare an error. The second signature bars a function, whose empty `keyof` would otherwise
  // satisfy `Overrides` and swallow every closure before the first signature checks it.
  state<V>(state: (context: StateContext<C, M>) => Overrides<C, M, V>): Factory<C, M, R, S>;
  state<V extends Record<string, unknown>>(state: Overrides<C, M, V>): Factory<C, M, R, S>;
}

/**
 * A factory bound to one model, carrying one method per state its config declares. Every call
 * returns a new factory, leaving the receiver untouched.
 *
 * Attributes merge in one order: the definition, then the states in the order they were applied,
 * then the overrides `create` was given. Last write wins per key; a key valued `undefined` is
 * skipped at every layer, so the layer before it stands; a `null` is written.
 *
 * `count` takes a non-negative whole number and throws a `RangeError` on anything else; `count(0)`
 * is legal and creates no records.
 *
 * @example
 * ```ts
 * const admins = users.count(3).suspended();
 * const rows = await admins.using(tx).create({ name: "Ada" });
 * ```
 */
export type Factory<C, M extends ModelName<C>, R = Row<C, M>, S = Record<never, never>> = FactoryMethods<C, M, R, S> & {
  [K in keyof S]: () => Factory<C, M, R, S>;
};

type Written = Record<string, unknown>;

interface CreateDelegate {
  create(args: { data: Written }): Promise<unknown>;
}

type Step = (context: EvaluationContext & { attrs: Written; parent: unknown }) => Written;

interface FactoryChain<C, M extends ModelName<C>> {
  model: M;
  definition: (context: EvaluationContext) => Written;
  declared: Record<string, Step>;
  applied: readonly Step[];
  client: () => Pick<C, M>;
  faker: FakerProvider;
  batch: number | undefined;
}

function step(state: unknown): Step {
  return typeof state === "function" ? (state as Step) : (): Written => state as Written;
}

/**
 * Turns a config's declared states into the steps a chain applies, rejecting a name the factory
 * already answers to.
 *
 * @example
 * ```ts
 * const declared = declaredStates({ suspended: { name: null } });
 * ```
 */
export function declaredStates(states: Record<string, unknown> | undefined): Record<string, Step> {
  const declared: Record<string, Step> = {};

  for (const [name, state] of Object.entries(states ?? {})) {
    if (reservedNames.includes(name))
      throw new TypeError(`The state "${name}" collides with the factory method of the same name. Rename the state.`);

    declared[name] = step(state);
  }

  return declared;
}

// Only the top level: a nested relation input carries Prisma's own meaning for `undefined`.
function given(attributes: Written | undefined): Written {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([, value]) => value !== undefined));
}

async function write<C, M extends ModelName<C>>(
  chain: FactoryChain<C, M>,
  overrides: Written | undefined,
): Promise<unknown[]> {
  // One faker serves the whole batch, so a seeded run replays the same values in the same order.
  const faker = await chain.faker();
  const delegate = chain.client()[chain.model] as CreateDelegate;
  const applied = given(overrides);
  const rows: unknown[] = [];

  for (let index = 0; index < (chain.batch ?? 1); index += 1) {
    const context = { faker, index, uid: nextUid(), parent: undefined };
    let attrs = given(chain.definition(context));

    for (const state of chain.applied) attrs = { ...attrs, ...given(state({ ...context, attrs })) };

    rows.push(await delegate.create({ data: { ...attrs, ...applied } }));
  }

  return rows;
}

/**
 * Builds a factory over the chain of definition, states, client and batch size a fluent call has
 * accumulated.
 *
 * @example
 * ```ts
 * const users = createFactory<PrismaClient, "user", Row<PrismaClient, "user">, object>(chain);
 * ```
 */
export function createFactory<C, M extends ModelName<C>, R, S>(chain: FactoryChain<C, M>): Factory<C, M, R, S> {
  const derive = (state: Step): Factory<C, M, R, S> => createFactory({ ...chain, applied: [...chain.applied, state] });

  const methods: FactoryMethods<C, M, R, S> = {
    async create<O>(overrides?: Overrides<C, M, O>): Promise<R> {
      const rows = await write(chain, overrides as Written | undefined);
      return (chain.batch === undefined ? rows[0] : rows) as R;
    },
    count(records: number): Factory<C, M, Row<C, M>[], S> {
      if (!Number.isInteger(records) || records < 0)
        throw new RangeError(`count(${String(records)}) is not a batch size. Pass a non-negative whole number.`);

      return createFactory({ ...chain, batch: records });
    },
    using(client: Pick<C, M>): Factory<C, M, R, S> {
      return createFactory({ ...chain, client: () => client });
    },
    state(state: unknown): Factory<C, M, R, S> {
      return derive(step(state));
    },
  };

  const named = Object.entries(chain.declared).map(([name, state]) => [name, (): Factory<C, M, R, S> => derive(state)]);

  return { ...methods, ...Object.fromEntries(named) } as Factory<C, M, R, S>;
}
