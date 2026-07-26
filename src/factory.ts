import {
  inverseRelationField,
  relationFieldsOf,
  resolveRelationField,
  resolveRowRelationField,
  targetScalars,
} from "./datamodel.js";
import type { FakerInstance, FakerProvider } from "./faker.js";
import type {
  Attributes,
  ChildModel,
  ChildValue,
  CreateInput,
  HasManyArgs,
  ModelName,
  Overrides,
  ParentModel,
  ParentValue,
  PartialAttributes,
  RelationArgs,
  Row,
} from "./prisma.js";
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
  /**
   * The record this one is created for: the row a `has` layer created just before reaching this
   * factory, its generated id and every database default carried. A record no `has` layer brought
   * has none, which is what the `undefined` stands for.
   *
   * The type spans every model the client carries, since the model at the far end of a relation is
   * not knowable from this one, so a field only some of them declare is reached by narrowing first.
   *
   * @example
   * ```ts
   * const credited = ({ parent }: StateContext<PrismaClient, "post">) => ({ title: `by ${String(parent?.id)}` });
   * ```
   */
  parent: Row<C, ModelName<C>> | undefined;
}

/**
 * The two shapes a `states` entry takes: the attributes to merge over what is evaluated so far,
 * given outright or computed.
 *
 * Widening a state to this type drops the check that it names only fields the model declares, so
 * keep a reusable state at its own shape — `satisfies PartialAttributes<C, M>` pins it without
 * widening.
 *
 * @example
 * ```ts
 * const states: Record<string, StateInput<PrismaClient, "user">> = { suspended: { name: null } };
 * ```
 */
export type StateInput<C, M extends ModelName<C>> =
  PartialAttributes<C, M> | ((context: StateContext<C, M>) => PartialAttributes<C, M>);

// Assignability alone lets a state name a field the model does not declare: excess property
// checking reaches a fresh object literal only, never one held in a variable or returned from a
// block body. Routing both forms through `Overrides` closes that gap, and `infer A` takes the
// closure's return type whole, so a state returning a union of shapes stays legal.
type ExactState<C, M extends ModelName<C>, V> = V extends (context: StateContext<C, M>) => infer A
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
// be unreachable. `then` is reserved for a second reason: a factory carrying one is thenable, and
// awaiting it never settles. Every key here is also listed in `reservedNames`, which enforces the
// same rule at runtime for callers who compile nothing.
interface Reserved {
  create?: never;
  count?: never;
  using?: never;
  state?: never;
  for?: never;
  has?: never;
  then?: never;
}

const reservedNames = ["create", "count", "using", "state", "for", "has", "then"];

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
 * `S` carries the declared state names, which the compiler reads off the object passed to `define`.
 * Annotating a config leaves `S` unsupplied, and a config typed that way accepts no `states` at all
 * — declare states inline at the `define` call, where both their names and their fields are checked.
 *
 * @example
 * ```ts
 * const config: FactoryConfig<PrismaClient, "user"> = {
 *   definition: ({ uid }) => ({ email: `${uid}@example.com` }),
 * };
 * ```
 */
export interface FactoryConfig<C, M extends ModelName<C>, D = CreateInput<C, M>, S = never> {
  definition: (context: EvaluationContext) => Attributes<C, M, D>;
  states?: S & StateMap<C, M>;
}

/**
 * The escape hatch `has` trails its arguments with.
 *
 * `inverse` names the relation field the child model reaches its parent back through, for a relation
 * whose two sides the client's metadata cannot pair down to one. It bypasses that lookup and nothing
 * else, so the form connecting rows — which never looks an inverse up — is untouched by it.
 *
 * @example
 * ```ts
 * const options: HasOptions = { inverse: "author" };
 * ```
 */
export interface HasOptions {
  inverse?: string | undefined;
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
  /**
   * Redirects the records this factory creates to a client of its own, an interactive transaction's
   * among them.
   *
   * Every parent factory a create resolves runs on that client too, however many models the chain of
   * relation defaults reaches through, so one call covers the whole graph. A parent factory that
   * named a client of its own keeps it, and its own parents then run on that one.
   *
   * @example
   * ```ts
   * await prisma.$transaction(async (tx) => posts.for(users, "author").using(tx).create());
   * ```
   */
  using(client: Pick<C, M>): Factory<C, M, R, S>;
  // One signature per form, rather than one parameter typed as `StateInput`: each form has to reach
  // `Overrides` with the state's own shape inferred into it, which is what makes a field the model
  // does not declare an error. The closure form takes its return type through `ExactState`, the
  // same route a declared state takes, so both accept exactly the same states. The object form
  // bars a function, whose empty `keyof` would otherwise satisfy `Overrides` and swallow every
  // closure before the first signature checked it.
  state<V extends (context: StateContext<C, M>) => unknown>(state: V & ExactState<C, M, V>): Factory<C, M, R, S>;
  state<V extends Record<string, unknown>>(state: Overrides<C, M, V>): Factory<C, M, R, S>;
  /**
   * Connects every record this factory creates to one parent, named by a factory of the parent model
   * or by a row of it.
   *
   * The relation field may be left out where the model pair shares exactly one belongs-to relation,
   * and must be named where it shares several. A parent factory is evaluated once per `create` call,
   * so a batch connects to one record rather than to one each. The relation field merges at the
   * position `for` was called: a state applied after it wins that field, a state applied before it
   * loses, and `create`'s overrides win over both.
   *
   * @example
   * ```ts
   * const drafts = await posts.count(3).for(users, "author").create();
   * ```
   */
  for<T extends ParentValue<C>>(parent: T, ...args: RelationArgs<C, M, ParentModel<C, T>>): Factory<C, M, R, S>;
  /**
   * Fills a relation field this model holds many records in, alongside every record it creates.
   *
   * The relation field may be left out where the model pair shares exactly one has-many relation, and
   * must be named where it shares several. Rows are connected as they stand, no record of the child
   * model being created for them; a child factory creates records of its own per parent record and
   * reaches back through the inverse relation field, which `inverse` names where the client's metadata
   * pairs the two sides down to more than one. Every child of one record is created before the next
   * record of a batch is, layer by layer in the order the calls were made, and each one reads the
   * record it was created for through `parent`.
   *
   * `has` adds to the relation field rather than replacing it: two calls on one field both apply, and
   * a call made after a state adds to what that state left standing. Every other layer — a definition
   * value, a state, the overrides `create` was given — replaces the field whole, children and all.
   *
   * @example
   * ```ts
   * const author = await users.has(posts.count(3), "posts").create();
   * ```
   */
  has<T extends ChildValue<C>>(
    children: T,
    ...args: HasManyArgs<C, M, ChildModel<C, T>, HasOptions>
  ): Factory<C, M, R, S>;
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

// The relation field a `for` call selects is resolved against the client's metadata, which a thunk
// client has none of before the first create, so the call keeps its arguments and nothing more.
interface Relation {
  parent: Record<string, unknown>;
  relationField: string | undefined;
}

// Kept whole for the same reason a `Relation` is, and told from one by the key it carries.
interface Children {
  children: object;
  relationField: string | undefined;
  inverse: string | undefined;
}

type Layer = Step | Relation | Children;

interface FactoryChain<C, M extends ModelName<C>> {
  model: M;
  definition: (context: EvaluationContext) => Written;
  declared: Record<string, Step>;
  applied: readonly Layer[];
  client: () => Pick<C, M>;
  // Set by `using` alone: a client the chain inherited gives way to the client of the chain resolving
  // it, a client `using` named does not.
  explicit: boolean;
  faker: FakerProvider;
  batch: number | undefined;
  // Set by the `has` layer creating this chain's records, and read by every layer of the merge.
  parent: unknown;
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
  // Prototype-free: a state named `__proto__` would otherwise reach the prototype setter, leaving
  // the factory with a method that silently does not exist.
  const declared = Object.create(null) as Record<string, Step>;

  for (const [name, state] of Object.entries(states ?? {})) {
    if (reservedNames.includes(name))
      throw new TypeError(`The state "${name}" takes a name a factory reserves. Rename the state.`);

    declared[name] = step(state);
  }

  return declared;
}

// Only the top level: a nested relation input carries Prisma's own meaning for `undefined`.
function given(attributes: Written | undefined): Written {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([, value]) => value !== undefined));
}

// Registered globally: a duplicated package instance recognises the other instance's factories.
const brand = Symbol.for("prisma-factorio.factory");
const rebind = Symbol.for("prisma-factorio.rebind");
const bearer = Symbol.for("prisma-factorio.parent");

// Every operation Prisma's create input accepts inside a relation field, to-one and to-many alike.
// A value naming only these is Prisma's own input, and reaches the client untouched.
const relationOperations = ["connect", "create", "connectOrCreate", "createMany"];

// The brand holds the factory's model, which is the parent model a `for` call needs and the one
// thing a value standing in a relation field cannot be asked for. The rebind and the bearer are
// absent from the stand-in `shared` builds, which has taken its client already and bears no parent.
interface Embedded {
  create: (overrides?: Written) => Promise<unknown>;
  [brand]: string;
  [rebind]?: (client: unknown) => Embedded;
  [bearer]?: (parent: unknown) => Embedded;
}

// A row carries whatever columns the model declares, `create` among them where the schema says so,
// so the brand is what tells a factory from a row.
function isFactory(value: object): value is Embedded {
  return brand in value;
}

// What a `has` layer writes under the relation field it names, in place of a value Prisma takes:
// `base` is what the layers before it left standing, `entries` every child added to that field, in
// call order. A layer of any other kind overwrites the key, which drops the children along with it.
const attached = Symbol("prisma-factorio.attached");

interface Attachment {
  children: object;
  inverse: string | undefined;
}

interface Attached {
  [attached]: true;
  base: unknown;
  entries: readonly Attachment[];
}

// What the parent's own create leaves behind: a factory creating records once the parent row exists,
// the relation field they hang off it by, and the inverse relation field where the call named one.
interface Pending {
  field: string;
  children: Embedded;
  inverse: string | undefined;
}

interface Resolved {
  data: Written;
  pending: Pending[];
}

function isAttached(value: unknown): value is Attached {
  return typeof value === "object" && value !== null && attached in value;
}

function listed(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

function accumulating(held: unknown, entry: Attachment): Attached {
  const previous = isAttached(held) ? held : undefined;

  return {
    [attached]: true,
    base: previous === undefined ? held : previous.base,
    entries: [...(previous?.entries ?? []), entry],
  };
}

// A row and Prisma's own relation input are both plain objects; a value carrying a prototype of its
// own — a date, a byte array, a scalar list — is neither, and stands for itself.
function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined;
}

// A parent is created through the client the chain resolving it runs on, so one `using` covers the
// whole graph a create reaches; a parent whose own chain named a client keeps that one.
function inheriting(parent: Embedded, client: unknown): Embedded {
  return parent[rebind]?.(client) ?? parent;
}

// The row a child factory hangs off, handed over just before its create so that a state closure of
// its own reads the record it is created for.
function bearing(children: Embedded, parent: unknown): Embedded {
  return children[bearer]?.(parent) ?? children;
}

async function connected(
  client: unknown,
  model: string,
  field: string,
  value: Record<string, unknown>,
): Promise<unknown> {
  if (isFactory(value)) return { connect: await inheriting(value, client).create() };

  const keys = Object.keys(value);

  // Every scalar of the row goes into the `where`: the runtime datamodel marks no field unique, so no
  // subset of them is knowably the one Prisma would match on. Every extra field narrows the match,
  // which is what makes a stale row fail rather than reach the record it has become. A relation the
  // row carries is no field to match on at all — a row loaded with `include` carries one — so the
  // where-clause is what the target model declares as scalars and nothing else.
  return keys.length > 0 && keys.every((key) => relationOperations.includes(key))
    ? value
    : { connect: targetScalars(client, model, field, value) };
}

// A single connect is what a to-one relation field takes and what a to-many one accepts alongside the
// list, so whatever the layers before the `has` call left standing is widened before the rows join it.
function connecting(base: Written, rows: unknown[]): Written {
  if (rows.length === 0) return base;

  const held = base.connect;

  return { ...base, connect: [...(held === undefined ? [] : listed(held)), ...rows] };
}

// The two forms part here: a row goes into the connect list the parent's own create carries, and a
// factory goes into `pending`, which is created once that create has returned the parent row.
async function attaching(
  client: unknown,
  model: string,
  field: string,
  value: Attached,
  pending: Pending[],
): Promise<Written> {
  const rows: unknown[] = [];

  for (const entry of value.entries) {
    if (isFactory(entry.children)) {
      pending.push({ field, children: entry.children, inverse: entry.inverse });
      continue;
    }

    for (const row of listed(entry.children)) rows.push(targetScalars(client, model, field, row as Written));
  }

  const held = plainObject(value.base);
  const base = held === undefined ? {} : ((await connected(client, model, field, held)) as Written);

  return connecting(base, rows);
}

async function resolved(client: unknown, model: string, data: Written): Promise<Resolved> {
  const embedded = Object.entries(data).flatMap(([key, value]) => {
    const object = plainObject(value);
    return object === undefined ? [] : [[key, object] as const];
  });

  if (embedded.length === 0) return { data, pending: [] };

  const relations = relationFieldsOf(client, model);
  const pending: Pending[] = [];
  const written: Written = { ...data };

  for (const [key, value] of embedded) {
    if (!relations.includes(key)) continue;

    if (!isAttached(value)) {
      written[key] = await connected(client, model, key, value);
      continue;
    }

    const input = await attaching(client, model, key, value, pending);

    // Children the parent's own create says nothing about — factories, and none at all — leave the
    // relation field unwritten rather than naming it and giving Prisma nothing to do.
    written[key] = Object.keys(input).length === 0 ? undefined : input;
  }

  return { data: given(written), pending };
}

// The children a `has` layer left pending are created once the parent row exists, through their own
// factory, so every layer their own chain holds still applies. They reach back to that row on the
// relation field pairing with the one they hang off it by, which the escape hatch names outright in
// place of looking it up.
async function borne(client: unknown, model: string, row: unknown, entry: Pending): Promise<void> {
  const target = entry.children[brand];
  const back = entry.inverse ?? inverseRelationField(client, model, entry.field);
  const connect = targetScalars(client, target, back, row as Written);

  await bearing(inheriting(entry.children, client), row).create({ [back]: { connect } });
}

// A `for` call names one specific parent, so the parent factory runs at most once however many
// records the batch holds, and the record it created is what every one of them connects to.
function shared(parent: Record<string, unknown>, client: unknown): Record<string, unknown> {
  if (!isFactory(parent)) return parent;

  const factory = inheriting(parent, client);
  let row: Promise<unknown> | undefined;

  return { create: (): Promise<unknown> => (row ??= factory.create()), [brand]: factory[brand] };
}

// The parent stays inert here rather than being created: a layer whose relation field a later layer
// overwrites is dropped by the merge, and only what the merge leaves standing is ever evaluated.
function relationStep(client: unknown, model: string, { parent, relationField }: Relation): Step {
  const field = isFactory(parent)
    ? resolveRelationField(client, model, parent[brand], relationField)
    : resolveRowRelationField(client, model, parent, relationField);
  const value = shared(parent, client);

  return (): Written => ({ [field]: value });
}

function attachField(client: unknown, model: string, { children, relationField }: Children): string | undefined {
  if (isFactory(children)) return resolveRelationField(client, model, children[brand], relationField);

  const [first] = listed(children) as (Record<string, unknown> | undefined)[];

  return first === undefined ? undefined : resolveRowRelationField(client, model, first, relationField);
}

// A layer holding no child at all names no relation field: there is nothing to connect and nothing to
// create, so the field is left exactly as the layers around it leave it.
function attachStep(client: unknown, model: string, layer: Children): Step {
  const field = attachField(client, model, layer);

  if (field === undefined) return (): Written => ({});

  const entry: Attachment = { children: layer.children, inverse: layer.inverse };

  return ({ attrs }): Written => ({ [field]: accumulating(attrs[field], entry) });
}

function layerStep(client: unknown, model: string, layer: Layer): Step {
  if (typeof layer === "function") return layer;

  return "children" in layer ? attachStep(client, model, layer) : relationStep(client, model, layer);
}

async function write<C, M extends ModelName<C>>(
  chain: FactoryChain<C, M>,
  overrides: Written | undefined,
): Promise<unknown[]> {
  // One faker serves the whole batch, so a seeded run replays the same values in the same order.
  const faker = await chain.faker();
  const client = chain.client();
  const model = String(chain.model);
  const delegate = client[chain.model] as CreateDelegate;
  const applied = given(overrides);
  const steps = chain.applied.map((layer) => layerStep(client, model, layer));
  const rows: unknown[] = [];

  for (let index = 0; index < (chain.batch ?? 1); index += 1) {
    const context = { faker, index, uid: nextUid(), parent: chain.parent };
    let attrs = given(chain.definition(context));

    for (const state of steps) attrs = { ...attrs, ...given(state({ ...context, attrs })) };

    const { data, pending } = await resolved(client, model, { ...attrs, ...applied });
    const row = await delegate.create({ data });

    // Depth first, layers in the order they were called: every child of one record exists before the
    // next record of the batch is created.
    for (const entry of pending) await borne(client, model, row, entry);

    rows.push(row);
  }

  return rows;
}

/**
 * Builds a factory over the chain of definition, states, client and batch size a fluent call has
 * accumulated.
 *
 * Every factory this returns carries `Symbol.for("prisma-factorio.factory")`, non-enumerable, valued
 * with the factory's own model: its presence is how a value standing in a relation field is told from
 * a row of that model, and its value is the parent model `for` resolves a relation field against.
 *
 * It carries `Symbol.for("prisma-factorio.rebind")` the same way, valued with a call that takes a
 * client and hands back this factory bound to it — or this factory untouched, where `using` named a
 * client of its own. Resolving a relation calls it, which is what spreads one `using` over a graph.
 *
 * It carries `Symbol.for("prisma-factorio.parent")` the same way, valued with a call that takes a row
 * and hands back this factory creating its records for it. A `has` layer calls it once per parent
 * record, which is what puts that record in reach of the children's own state closures.
 *
 * @example
 * ```ts
 * const users = createFactory<PrismaClient, "user", Row<PrismaClient, "user">, object>(chain);
 * ```
 */
export function createFactory<C, M extends ModelName<C>, R, S>(chain: FactoryChain<C, M>): Factory<C, M, R, S> {
  const derive = (layer: Layer): Factory<C, M, R, S> => createFactory({ ...chain, applied: [...chain.applied, layer] });

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
      return createFactory({ ...chain, client: () => client, explicit: true });
    },
    state(state: unknown): Factory<C, M, R, S> {
      return derive(step(state));
    },
    for(parent: object, relationField?: string): Factory<C, M, R, S> {
      return derive({ parent: parent as Record<string, unknown>, relationField });
    },
    has(children: object, ...args: unknown[]): Factory<C, M, R, S> {
      const [first, second] = args;
      const named = typeof first === "string";
      const options = (named ? second : first) as HasOptions | undefined;

      return derive({ children, relationField: named ? first : undefined, inverse: options?.inverse });
    },
  };

  const named = Object.entries(chain.declared).map(([name, state]) => [name, (): Factory<C, M, R, S> => derive(state)]);
  const factory = { ...methods, ...Object.fromEntries(named) } as Factory<C, M, R, S>;

  // The chain resolving a relation holds the whole client rather than one delegate, so the client it
  // hands over serves this factory's model as well as its own.
  const inherit = (client: unknown): Factory<C, M, R, S> =>
    chain.explicit ? factory : createFactory({ ...chain, client: () => client as Pick<C, M> });
  const bear = (parent: unknown): Factory<C, M, R, S> => createFactory({ ...chain, parent });

  Object.defineProperty(factory, brand, { value: String(chain.model) });
  Object.defineProperty(factory, rebind, { value: inherit });

  return Object.defineProperty(factory, bearer, { value: bear });
}
