import {
  foreignKeyOf,
  type ForeignKey,
  holdsManyRecords,
  inverseRelationField,
  type InverseAdvice,
  namedRelationField,
  presentDelegate,
  relationFieldsOf,
  resolveRelationField,
  resolveRowRelationField,
  targetWhere,
} from "./datamodel.js";
import type { FakerInstance, FakerProvider } from "./faker.js";
import { mergedPool, recycledPool, type Pool } from "./pool.js";
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
import type { Picker } from "./rng.js";
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
   * The record this one is created for: the row created just before reaching this factory, its
   * generated id and every database default carried. A `has` layer brings one, and so does a factory
   * standing in a relation field that holds many records. A record neither brought has none, which is
   * what the `undefined` stands for.
   *
   * The type spans every model the client carries, since the model at the far end of a relation is
   * not knowable from this one, so a field only some of them declare is reached by narrowing first.
   *
   * @example
   * ```ts
   * const credited = ({ parent }: StateContext<PrismaClient, "post">) => ({
   *   title: parent !== undefined && "id" in parent ? `by ${String(parent.id)}` : "unattributed",
   * });
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
  recycle?: never;
  afterCreating?: never;
  then?: never;
}

const reservedNames = ["create", "count", "using", "state", "for", "has", "recycle", "afterCreating", "then"];

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
 * `afterCreating` declares the one callback every record this factory persists is followed by — see
 * {@link AfterCreating} — and {@link FactoryMethods.afterCreating} adds more behind it.
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
  afterCreating?: AfterCreating<C, M>;
}

/**
 * A side effect that follows every record a factory persists.
 *
 * `row` is the record as the database left it, generated id and column defaults carried, and `client`
 * is the client this chain writes through — the one `using` named, where a call named one — so a write
 * the callback makes lands wherever the record itself did. Whatever the callback returns is awaited
 * and then discarded.
 *
 * The client stands here as every model delegate rather than as the client whole, an interactive
 * transaction carrying none of the client's own methods. `using` asks for less than that — one
 * delegate is all it takes — so a chain redirected to a hand-built stub carrying fewer models leaves a
 * callback reaching a second one to the caller.
 *
 * @example
 * ```ts
 * const announced: AfterCreating<PrismaClient, "user"> = async (user, { client }) => {
 *   await client.post.create({ data: { title: "Hello", author: { connect: { id: user.id } } } });
 * };
 * ```
 */
export type AfterCreating<C, M extends ModelName<C>> = (
  row: Row<C, M>,
  context: { client: Pick<C, ModelName<C>> },
) => unknown;

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
 * const rows = await userFactory.count(3).state({ name: "Ada" }).create();
 * ```
 */
export interface FactoryMethods<C, M extends ModelName<C>, R, S> {
  // The naked `O` beside `Overrides` is what infers a value typed as a union of the create input's
  // branches whole, rather than collapsing it to one branch. That holds only on a required
  // parameter, an optional one being a union with `undefined` that splits the value branch by
  // branch, so the call without overrides, and a helper forwarding its own optional overrides, take
  // the second signature.
  create<O>(overrides: O & Overrides<C, M, O>): Promise<R>;
  create<O>(overrides?: Overrides<C, M, O>): Promise<R>;
  count(records: number): Factory<C, M, Row<C, M>[], S>;
  /**
   * Redirects the records this factory creates to a client of its own, an interactive transaction's
   * among them.
   *
   * Every parent factory a create resolves runs on that client too, as does every child factory a
   * `has` layer creates records through, however many models the graph reaches, so one call covers it
   * whole. What is handed down is the client itself rather than the one delegate this signature names,
   * so it has to be a generated client, or a derivative of one keeping its relation metadata — which an
   * interactive transaction's does. A hand-built object of delegates keeps none, so it type-checks here
   * and then throws the moment the graph reaches a second model, however many delegates it carries.
   *
   * A factory that named a client of its own through `using` keeps it, and the factories it resolves in
   * turn then run on that one. A factory that named none runs on this client instead, silently — a
   * factory of another bootstrap among them, bound where it was defined.
   *
   * @example
   * ```ts
   * await prisma.$transaction(async (tx) => postFactory.for(userFactory, "author").using(tx).create());
   * ```
   */
  using(client: Pick<C, M>): Factory<C, M, R, S>;
  // One signature per form, rather than one parameter typed as `StateInput`: each form has to reach
  // `Overrides` with the state's own shape inferred into it, which is what makes a field the model
  // does not declare an error. The closure form takes its return type through `ExactState`, the
  // same route a declared state takes, so both accept exactly the same states. The object form
  // takes its shape through a naked `V` as well, as `create` does, and bars a function, whose empty
  // `keyof` would otherwise satisfy `Overrides` and swallow every closure before the first signature
  // checked it.
  state<V extends (context: StateContext<C, M>) => unknown>(state: V & ExactState<C, M, V>): Factory<C, M, R, S>;
  state<V extends Record<string, unknown>>(state: V & Overrides<C, M, V>): Factory<C, M, R, S>;
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
   * const drafts = await postFactory.count(3).for(userFactory, "author").create();
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
   * const author = await userFactory.has(postFactory.count(3), "posts").create();
   * ```
   */
  has<T extends ChildValue<C>>(
    children: T,
    ...args: HasManyArgs<C, M, ChildModel<C, T>, HasOptions>
  ): Factory<C, M, R, S>;
  /**
   * Pools existing rows of one model, so that a factory of that model standing in a relation field
   * connects a pooled row rather than creating a record.
   *
   * The model is named outright, a row carrying nothing that says which model it belongs to. Rows
   * merge across calls rather than replacing one another, so a factory configured with a pool and
   * recycled again at a call site keeps its baseline rows, and every model keeps a list of its own.
   * Pooling no rows is legal and leaves the model exactly as it stands.
   *
   * The pool reaches every factory the graph resolves, however deep, and gives way to the caller's
   * own choice of parent: a `for` layer and the overrides `create` was given each create a record of
   * their own, while a factory arriving through the definition or through a state — declared or
   * inline — is drawn from. That precedence covers the slot named and nothing under it, so the pool
   * still fills the graph beneath such a parent. Nothing the graph creates ever joins the pool.
   *
   * A factory of a pooled model connects drawn rows in place of creating records — one pick per record
   * that chain would have created, drawn with replacement — whether it arrives as the children of a
   * `has` layer or stands in a relation field holding many records.
   *
   * A row of the named model is what the argument takes, whatever else it carries: pooled rows
   * connect on every non-null scalar of the target model the where-clause can hold, plus the
   * compound selector for each unique constraint the row names whole, so one loaded with `include`
   * stands here as readily as one straight from a create.
   *
   * @example
   * ```ts
   * const comment = await commentFactory.recycle("user", ada).create();
   * ```
   */
  recycle<P extends ModelName<C>>(model: P, rows: Row<C, P> | readonly Row<C, P>[]): Factory<C, M, R, S>;
  /**
   * Registers a side effect to run once every record this factory creates stands complete.
   *
   * Calls accumulate rather than replace one another, and a callback the config declared runs ahead of
   * every callback registered here. They run one at a time, in that order, each awaited before the
   * next begins, and a batch runs the whole list per record — so `count(0)` runs none. A callback runs
   * where a record was created and nowhere else: a row a recycle pool stood in with was connected
   * rather than created, and nothing fires for it.
   *
   * The record reaches the callback with its `has` children already written, and the callbacks of a
   * parent this factory resolved have already run by then, so the graph the callback reads is whole.
   *
   * @example
   * ```ts
   * const welcomed = await userFactory
   *   .afterCreating(async (user, { client }) => {
   *     await client.post.create({ data: { title: "Welcome", author: { connect: { id: user.id } } } });
   *   })
   *   .create();
   * ```
   */
  afterCreating(callback: AfterCreating<C, M>): Factory<C, M, R, S>;
}

/**
 * A factory bound to one model, carrying one method per state its config declares. Every call
 * returns a new factory, leaving the receiver untouched.
 *
 * Attributes merge in one order: the definition, then the states in the order they were applied,
 * then the overrides `create` was given. Last write wins per key, save for the relation field a `has`
 * layer adds to rather than replaces — see {@link FactoryMethods.has}; a key valued `undefined` is
 * skipped at every layer, so the layer before it stands; a `null` is written. A relation field and
 * the columns of the foreign key backing it count as one key: a layer writing any of those columns
 * drops the relation field an earlier layer wrote, and a layer writing the relation field drops the
 * columns an earlier layer wrote. Where the create keeps another relation on `connect`, a column set
 * named whole reaches Prisma as a `connect` on its own relation field, and one wholly `null` as that
 * field left out. A model whose foreign keys the client's schema text does not name merges key by key.
 *
 * `count` takes a non-negative whole number and throws a `RangeError` on anything else; `count(0)`
 * is legal and creates no records.
 *
 * @example
 * ```ts
 * const adminFactory = userFactory.count(3).suspended();
 * const rows = await adminFactory.using(tx).create({ name: "Ada" });
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
  // The config seeds this list and the fluent method appends to it, which is the order they run in.
  callbacks: readonly AfterCreating<C, M>[];
  client: () => Pick<C, M>;
  // Set by `using` alone: a client the chain inherited gives way to the client of the chain resolving
  // it, a client `using` named does not.
  explicit: boolean;
  faker: FakerProvider;
  batch: number | undefined;
  // Set by the `has` layer creating this chain's records, and read by every layer of the merge.
  parent: unknown;
  pool: Pool;
  // One stream per bootstrap, so a seeded run replays every pick a graph makes, in the order it
  // makes them.
  pick: Picker;
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
const recycler = Symbol.for("prisma-factorio.recycle");

// Local to this module: the mark rides on the stand-in `shared` builds and is read where that
// stand-in is resolved, both of which are this file.
const chosen = Symbol("prisma-factorio.chosen");

// Every operation Prisma's create input accepts inside a relation field, to-one and to-many alike.
// A value naming only these is Prisma's own input, and reaches the client untouched.
const relationOperations = ["connect", "create", "connectOrCreate", "createMany"];

// The pool a chain hands down, which the factory receiving it merges into the one it carries itself,
// and the number of records that chain creates — which is how many rows stand in for them where the
// pool names their model. `undefined` is the one record an unbatched chain creates.
interface Recycler {
  draw: (pool: Pool, pick: Picker) => Embedded;
  batch: number | undefined;
}

// The brand holds the factory's model, which is the parent model a `for` call needs and the one
// thing a value standing in a relation field cannot be asked for. The rebind, the bearer and the
// recycler are absent from the stand-in `shared` builds, which has taken its client and its pool
// already and bears no parent; `chosen` marks that stand-in and nothing else.
interface Embedded {
  create: (overrides?: Written) => Promise<unknown>;
  [brand]: string;
  [rebind]?: (client: unknown) => Embedded;
  [bearer]?: (parent: unknown) => Embedded;
  [recycler]?: Recycler;
  [chosen]?: true;
}

// What resolving a relation takes beyond the value standing in it: the client the records are written
// through, and the pool a record of a pooled model is drawn from in place of being created. One wiring
// serves a whole `create()` call, so the fields it records span the batch — which is the span a stale
// row can fail over, a row one record connected going stale for the next. `drawnInto` holds the
// relation fields holding many records that pooled rows were drawn into; `matchedInto` every relation
// field a row the caller handed over or a pool drew was matched into, whatever its arity.
interface Wiring {
  client: unknown;
  pool: Pool;
  pick: Picker;
  drawnInto: string[];
  matchedInto: string[];
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
  // The position of the `has` call among the layers, which is the order its children are created in:
  // the layers of every relation field fall together in call order, behind the children a relation
  // field's own value left standing.
  order: number;
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
  // Which call a failed inverse lookup steers to: a `has` layer names the inverse through an option,
  // which a relation default reaches no form of.
  advice?: InverseAdvice;
  order: number;
}

interface Resolved {
  data: Written;
  pending: Pending[];
}

// The row a `has` child reaches its parent back through, created by this build a moment ago. It rides
// beside a native `connect` into another factory's `create`, which may belong to a duplicated package
// instance: one registered under the same key writes the row as its foreign key, and any other reads
// the `connect` alone, its keys naming nothing but that operation.
const created = Symbol.for("prisma-factorio.created");

interface Created {
  connect: Written;
  [created]: Written;
}

function isCreated(value: object): value is Created {
  return created in value;
}

// The rows standing in the relation fields of one create, keyed by relation field: every row the
// library holds there, handed over, drawn from a pool or created by this build. Only a row this build
// created is `fresh`: it cannot have gone stale, and so may be written as the foreign key it stands for.
type Held = Map<string, { row: Written; fresh: boolean }>;

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

// What may stand in a relation field: a row, a list of rows, a factory and Prisma's own relation input
// alike. A value carrying a prototype of its own — a date, a byte array — is none of them and stands
// for itself. A scalar list carries a list's own prototype, so what tells the two apart is the key the
// value falls under rather than the value itself.
type Standing = Record<string, unknown> | unknown[];

function standing(value: unknown): Standing | undefined {
  if (Array.isArray(value)) return value as unknown[];

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

// The pool a chain recycles reaches every factory it resolves, and through them the whole graph: a
// slot the pool leaves alone still hands it down, so the records created for that slot draw from it.
function recycling(embedded: Embedded, { pool, pick }: Wiring): Embedded {
  return embedded[recycler]?.draw(pool, pick) ?? embedded;
}

// A factory whose model the pool names stands for a row already written rather than for a record to
// create — unless the slot it stands in is the caller's own, which the pool never overrides. The pick
// is per record and drawn with replacement, so two records may well connect the same row.
function pooled(value: Embedded, { pool, pick }: Wiring, explicit: boolean): Record<string, unknown> | undefined {
  if (explicit || value[chosen] === true) return undefined;

  const rows = pool[value[brand]];

  // A model the pool names carries at least one row of that model — `recycledPool` keeps no empty
  // list, and `recycle` takes rows alone — so the pick is a row rather than the `undefined` a picker
  // answers an empty list with.
  return rows === undefined ? undefined : (pick(rows) as Record<string, unknown>);
}

// Every scalar of the row `targetScalars` keeps goes into the `where`, plus a compound selector for
// every unique constraint the row can name whole — the one match a model whose only unique
// constraint is compound answers to. The runtime datamodel marks no field unique, so no subset of the scalars is
// knowably the one Prisma would match on; every extra field narrows the match, which is what makes
// a stale row fail rather than reach the record it has become. A relation the row carries is no
// field to match on at all — a row loaded with `include` carries one, and so may a pooled row —
// so the where-clause is what `targetWhere` reads off the row and nothing else.
function matching(client: unknown, model: string, field: string, row: Record<string, unknown>): Written {
  return { connect: targetWhere(client, model, field, row) };
}

// The where-clause naming the record a foreign key's values point at: those values under the fields
// they reference, plus the compound selector Prisma matches a compound reference on.
function referencedWhere(client: unknown, model: string, field: string, key: ForeignKey, values: unknown[]): Written {
  return targetWhere(client, model, field, Object.fromEntries(key.references.map((name, at) => [name, values[at]])));
}

// A row this build created cannot have gone stale by anyone else's doing, while its own callbacks may
// already have changed its record, so it connects on the fields its key references alone. A key held
// at the far end or unreadable, or a referenced field the row holds no value in, leaves the row
// matched on every scalar.
function freshWhere(
  client: unknown,
  model: string,
  field: string,
  key: ForeignKey | null | undefined,
  row: Written,
): Written {
  if (key === null || key === undefined) return targetWhere(client, model, field, row);

  const values = key.references.map((name) => row[name]);

  return values.some((value) => value === null || value === undefined)
    ? targetWhere(client, model, field, row)
    : referencedWhere(client, model, field, key, values);
}

// A list connects as a list, which is what a relation field holding many records takes: a list found
// standing in a field that holds a single record keeps the value it was handed rather than reaching
// here, `resolved` turning it back on the arity. A single row connects on its own, the one shape both
// arities take. A list holding no row connects nothing at all, leaving the field to the layers around it.
function matchingAll(client: unknown, model: string, field: string, rows: readonly unknown[]): Written {
  return rows.length === 0 ? {} : { connect: rows.map((row) => targetWhere(client, model, field, row as Written)) };
}

// A value a relation field has no reading for: a list standing in a field that holds a single record,
// which keeps the value it was handed so that Prisma's own validation refuses it rather than the field
// going unwritten. A list is not the only value the arity is asked for — a factory standing in a field
// asks it too — and neither ask is dear: the answer is held per client, and a field holding a single
// record never reaches the database, Prisma refusing the probe filter where it stands.
async function unread(client: unknown, model: string, field: string, value: Standing): Promise<boolean> {
  return Array.isArray(value) && !(await holdsManyRecords(client, model, field));
}

// Prisma's own input, told from a row by the keys it carries: every one of them names an operation,
// where a row names the columns of a model.
function native(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);

  return keys.length > 0 && keys.every((key) => relationOperations.includes(key));
}

// The position a value standing in a relation field is created at, which is ahead of every `has` layer:
// no call named it, so it carries the order of none, and it ties with the values standing in the other
// relation fields, which a stable sort leaves in the order the keys of the merge fall.
const standingOrder = -1;

// A factory standing in a relation field holding many records is a `has` layer written as an attribute:
// its records hang off a row that does not exist yet, so they wait in `pending` rather than being
// created and connected, which would leave whatever their own foreign keys brought behind. A field
// holding a single record is the side the record has to exist first for, and is created here. The
// arity is asked ahead of the pool: a single connect is a shape both arities take, so a slot drawn
// before its arity is known would collapse a whole batch of children to one row.
async function embodied(
  wiring: Wiring,
  model: string,
  field: string,
  value: Embedded,
  pending: Pending[],
  explicit: boolean,
  held: Held | undefined,
): Promise<Written> {
  if (!(await holdsManyRecords(wiring.client, model, field))) {
    const picked = pooled(value, wiring, explicit);

    if (picked !== undefined) {
      held?.set(field, { row: picked, fresh: false });
      wiring.matchedInto.push(field);
      return matching(wiring.client, model, field, picked);
    }

    const row = await recycling(inheriting(value, wiring.client), wiring).create();

    // A batch factory standing in a field holding a single record hands back a list, which is left for
    // Prisma to refuse rather than being mangled into a match.
    if (Array.isArray(row)) return { connect: row };

    held?.set(field, { row: row as Written, fresh: true });

    return {
      connect: freshWhere(wiring.client, model, field, foreignKeyOf(wiring.client, model, field), row as Written),
    };
  }

  const picks = drawn(value, wiring, explicit);

  if (picks !== undefined) {
    wiring.drawnInto.push(field);
    wiring.matchedInto.push(field);
    return matchingAll(wiring.client, model, field, picks);
  }

  // The stand-in a `for` call leaves takes no overrides, so it has nothing to reach back through the
  // inverse relation with: pending children of it would hang off no parent at all.
  if (value[chosen] === true)
    throw new TypeError(
      `The relation field "${field}" on the model "${model}" holds many records, which for() has no reading for. ` +
        "Attach the records with has() instead.",
    );

  pending.push({ field, children: value, inverse: undefined, advice: "relation default", order: standingOrder });

  return {};
}

// `held` collects the rows standing in this create's own relation fields; a caller with no create of
// its own to rewrite — the base a `has` layer gathers on — passes none.
async function connected(
  wiring: Wiring,
  model: string,
  field: string,
  value: Standing,
  pending: Pending[],
  explicit = false,
  held?: Held,
): Promise<Written> {
  if (Array.isArray(value)) {
    if (value.length > 0) wiring.matchedInto.push(field);

    return matchingAll(wiring.client, model, field, value);
  }

  if (isFactory(value)) return embodied(wiring, model, field, value, pending, explicit, held);

  if (isCreated(value)) {
    held?.set(field, { row: value[created], fresh: true });

    return { connect: value.connect };
  }

  if (native(value)) return value;

  held?.set(field, { row: value, fresh: false });
  wiring.matchedInto.push(field);

  return matching(wiring.client, model, field, value);
}

// A single connect is what a to-one relation field takes and what a to-many one accepts alongside the
// list, so whatever the layers before the `has` call left standing is widened before the rows join it.
function connecting(base: Written, rows: unknown[]): Written {
  if (rows.length === 0) return base;

  const held = base.connect;

  return { ...base, connect: [...(held === undefined ? [] : listed(held)), ...rows] };
}

// A factory whose model the pool names stands for rows already written rather than for records to
// create: one pick per record its own chain would have created, drawn with replacement, so two of them
// may well be the same row. A chain batched to no records draws nothing, and goes on as the factory
// that creates nothing.
function drawn(children: Embedded, wiring: Wiring, explicit: boolean): Record<string, unknown>[] | undefined {
  const picks: Record<string, unknown>[] = [];

  for (let index = 0; index < (children[recycler]?.batch ?? 1); index += 1) {
    const row = pooled(children, wiring, explicit);

    if (row === undefined) return undefined;

    picks.push(row);
  }

  return picks.length === 0 ? undefined : picks;
}

// The two forms part here: a row goes into the connect list the parent's own create carries, and a
// factory goes into `pending`, which is created once that create has returned the parent row. Neither
// the children nor the base they gathered on top of is explicit: the layer names the relation field its
// children hang off and never a record standing in a slot, and an override replaces the relation field
// whole, children and all, so the base survived every override there was. A `for` stand-in does reach
// `connected` as that base, and stays the caller's own by the mark it carries rather than by the flag.
async function attaching(
  wiring: Wiring,
  model: string,
  field: string,
  value: Attached,
  pending: Pending[],
): Promise<Written> {
  const rows: unknown[] = [];

  for (const entry of value.entries) {
    if (isFactory(entry.children)) {
      const picks = drawn(entry.children, wiring, false);

      if (picks === undefined) {
        pending.push({ field, children: entry.children, inverse: entry.inverse, order: entry.order });
        continue;
      }

      wiring.drawnInto.push(field);
      wiring.matchedInto.push(field);
      for (const row of picks) rows.push(targetWhere(wiring.client, model, field, row));
      continue;
    }

    const handed = listed(entry.children);

    if (handed.length > 0) wiring.matchedInto.push(field);
    for (const row of handed) rows.push(targetWhere(wiring.client, model, field, row as Written));
  }

  const held = standing(value.base);
  const base = held === undefined ? {} : await connected(wiring, model, field, held, pending);

  return connecting(base, rows);
}

async function resolved(
  wiring: Wiring,
  model: string,
  data: Written,
  explicit: ReadonlySet<string>,
): Promise<Resolved> {
  const embedded = Object.entries(data).flatMap(([key, value]) => {
    const held = standing(value);
    return held === undefined ? [] : [[key, held] as const];
  });

  if (embedded.length === 0) return { data, pending: [] };

  const relations = relationFieldsOf(wiring.client, model);
  const pending: Pending[] = [];
  const written: Written = { ...data };
  const held: Held = new Map();

  for (const [key, value] of embedded) {
    if (!relations.includes(key)) continue;
    if (await unread(wiring.client, model, key, value)) continue;

    const input = isAttached(value)
      ? await attaching(wiring, model, key, value, pending)
      : await connected(wiring, model, key, value, pending, explicit.has(key), held);

    // What the parent's own create has nothing to say about — a list holding no row, children created
    // once the parent row exists, and none at all — leaves the relation field unwritten rather than
    // naming it and giving Prisma nothing to do.
    written[key] = Object.keys(input).length === 0 ? undefined : input;
  }

  const settled = given(written);

  agreed(wiring.client, model, settled, held);

  return {
    data: keyed(wiring.client, model, settled, held),
    pending: pending.sort((one, next) => one.order - next.order),
  };
}

// Two foreign keys sharing a column write one value there, which Prisma takes from whichever relation
// field comes last, or refuses outright: rows the library holds in both are told apart before then. A
// referenced value a row does not hold, and native relation input, which carries no row, are Prisma's
// to settle.
function agreed(client: unknown, model: string, data: Written, held: Held): void {
  const claims = new Map<string, { field: string; value: unknown }>();

  for (const field of Object.keys(data)) {
    const row = held.get(field)?.row;
    const key = row === undefined ? undefined : foreignKeyOf(client, model, field);

    if (row === undefined || key === null || key === undefined) continue;

    for (const [at, column] of key.fields.entries()) {
      const value = row[key.references[at] ?? ""];
      const claim = claims.get(column);

      if (value === null || value === undefined) continue;

      if (claim === undefined) claims.set(column, { field, value });
      else if (!same(claim.value, value))
        throw new TypeError(
          `The relation fields "${claim.field}" and "${field}" on the model "${model}" disagree on the foreign ` +
            `key column "${column}": "${claim.field}" holds ${shown(claim.value)} and "${field}" holds ` +
            `${shown(value)}. Pool the shared parent with recycle(), or hand the same row to both fields.`,
        );
    }
  }
}

// A foreign key references an id, so a value is a number, a bigint or a string; an object one — a
// date, a decimal, bytes — is a fresh instance per read, compared by what it serialises to.
function same(one: unknown, other: unknown): boolean {
  return typeof one === "object" && typeof other === "object"
    ? JSON.stringify(one) === JSON.stringify(other)
    : one === other;
}

function shown(value: unknown): string {
  return typeof value === "bigint" ? String(value) : JSON.stringify(value);
}

// The foreign key columns a fresh row stands for in one relation field, or nothing where any of them
// cannot be written: a referenced value the row does not hold, a column the caller wrote, or one some
// other key of the create already fills with another value. A column another key fills with the same
// value is written once, by that key.
function columnsOf(key: ForeignKey, row: Written, data: Written, filled: Written): Written | undefined {
  const columns: Written = {};

  for (const [at, column] of key.fields.entries()) {
    const value = row[key.references[at] ?? ""];

    if (value === null || value === undefined || column in data || column in columns) return undefined;

    if (column in filled) {
      if (!same(filled[column], value)) return undefined;
      continue;
    }

    columns[column] = value;
  }

  return columns;
}

// Prisma's create input is one of two shapes: the checked one, carrying a relation field wherever the
// model holds a foreign key, or the unchecked one, carrying the raw columns there instead and refusing
// those relation fields. A relation field holding no key — one holding many records, the side of a
// one-to-one whose key the far end holds — is accepted by both. So the columns are written only where
// every relation field holding a key is filled by a row this build created, and every relation
// otherwise goes on `connect`, the columns the caller wrote among them: a row the caller handed over or
// a pool drew may have gone stale, and matching it on every scalar is what makes that fail loudly.
function keyed(client: unknown, model: string, data: Written, held: Held): Written {
  const columns = columnsFor(client, model, data, held);

  return columns ?? reconnected(client, model, data);
}

function columnsFor(client: unknown, model: string, data: Written, held: Held): Written | undefined {
  const replaced = new Map<string, Written>();
  const filled: Written = {};

  for (const field of relationFieldsOf(client, model).filter((name) => name in data)) {
    const key = foreignKeyOf(client, model, field);

    if (key === null) continue;

    const entry = held.get(field);
    const row = entry?.fresh === true ? entry.row : undefined;
    const columns = key === undefined || row === undefined ? undefined : columnsOf(key, row, data, filled);

    if (columns === undefined) return undefined;

    Object.assign(filled, columns);
    replaced.set(field, columns);
  }

  return Object.fromEntries(
    Object.entries(data).flatMap(([name, value]) => {
      const columns = replaced.get(name);

      return columns === undefined ? [[name, value]] : Object.entries(columns);
    }),
  );
}

// Every relation field of a model whose foreign key the schema text names, beside that key. A field
// whose key is held at the far end, or cannot be read at all, pairs with no column.
type Pairing = readonly (readonly [field: string, key: ForeignKey])[];

function pairingOf(client: unknown, model: string): Pairing {
  return relationFieldsOf(client, model).flatMap((field) => {
    const key = foreignKeyOf(client, model, field);

    return key === null || key === undefined ? [] : [[field, key] as const];
  });
}

// A create left on `connect` takes no raw foreign key column, so a key whose columns the data names
// whole is written as a `connect` on the fields it references instead, and one whose columns are all
// `null` as the relation field left out. A key named in part, or holding `null` in part, is left for
// Prisma to refuse.
function reconnected(client: unknown, model: string, data: Written): Written {
  const keys = pairingOf(client, model);

  if (!keys.some(([field]) => field in data)) return data;

  const connects: Written = {};
  const consumed = new Set<string>();

  for (const [field, key] of keys) {
    if (field in data || !key.fields.every((column) => column in data)) continue;

    const values = key.fields.map((column) => data[column]);

    if (values.every((value) => value === null)) {
      for (const column of key.fields) consumed.add(column);
      continue;
    }

    if (values.some((value) => value === null)) continue;

    connects[field] = { connect: referencedWhere(client, model, field, key, values) };
    for (const column of key.fields) consumed.add(column);
  }

  return { ...Object.fromEntries(Object.entries(data).filter(([name]) => !consumed.has(name))), ...connects };
}

// The children left pending — by a `has` layer, or by a factory standing in a relation field holding
// many records — are created once the parent row exists, through their own factory, so every layer their
// own chain holds still applies. They reach back to that row on the relation field pairing with the one
// they hang off it by, which the escape hatch names outright in place of looking it up.
async function borne(wiring: Wiring, model: string, row: unknown, entry: Pending): Promise<void> {
  const { client } = wiring;
  const target = entry.children[brand];
  const back = entry.inverse ?? inverseRelationField(client, model, entry.field, entry.advice);
  // A child holding the foreign key reaches back through a row this build has just created, which its
  // own create may write as that key; any other back relation connects on the row's scalars.
  const key = foreignKeyOf(client, target, back);
  const connect = freshWhere(client, target, back, key, row as Written);
  const reach: Written = key === null ? { connect } : { connect, [created]: row };

  await bearing(recycling(inheriting(entry.children, client), wiring), row).create({ [back]: reach });
}

// The codes Prisma refuses a create with when a `connect` inside it finds none of the records it names,
// which of the two depending on the shape of the relation rather than on its arity alone: a connect
// into an implicit many-to-many answers with `P2025`, as one into a field holding a single record does.
const unmatchedConnect = "P2018";
const unmatchedRecord = "P2025";

function quoted(fields: readonly string[]): string {
  return [...new Set(fields)].map((field) => `"${field}"`).join(" or ");
}

// A create that drew pooled rows into a to-many relation field is the one whose connect can fail by the
// pool's own doing: a required foreign key rewritten by an earlier record's connect leaves the pooled
// copy matching nothing, which is retold in the pool's terms. Any other connect that matched nothing
// while a handed or pooled row stood in the call is retold as a stale row, naming every field such a
// row stood in across the call rather than the one that failed. Prisma's error stands behind either
// as the cause; a create no such row reached passes its failure through untouched.
async function persisted(delegate: CreateDelegate, data: Written, wiring: Wiring, model: string): Promise<unknown> {
  try {
    return await delegate.create({ data });
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;

    if (code === unmatchedConnect && wiring.drawnInto.length > 0)
      throw new Error(
        `A pooled row drawn into ${quoted(wiring.drawnInto)} on the model "${model}" ` +
          "no longer matches the database: a connect into a relation field backed by a required foreign key " +
          "re-homes the record, rewriting the column the pooled copy still carries, so a pooled row fills " +
          "such a relation once. Pool one row per parent record, or pass native relation input.",
        { cause: error },
      );

    if ((code === unmatchedConnect || code === unmatchedRecord) && wiring.matchedInto.length > 0)
      throw new Error(
        `A row connected into ${quoted(wiring.matchedInto)} on the model "${model}" no longer matches the ` +
          "database: it was read before its record changed, and every non-null scalar is matched on, so a " +
          "changed `updatedAt` is enough. Re-read the row from the client before handing it over or pooling " +
          "it, or pass native relation input ({ connect: { id } }) to match on the key alone.",
        { cause: error },
      );

    throw error;
  }
}

// A `for` call names one specific parent, so the parent factory runs at most once however many
// records the batch holds, and the record it created is what every one of them connects to.
function shared(wiring: Wiring, parent: Record<string, unknown>): Record<string, unknown> {
  if (!isFactory(parent)) return parent;

  const factory = recycling(inheriting(parent, wiring.client), wiring);
  let row: Promise<unknown> | undefined;

  // This `create` takes no overrides, though the type it stands in for declares them: one row answers
  // every record of the batch, so there is no single caller whose overrides it could carry. The mark
  // is what tells this parent from one a definition or a state names, the pool having to leave the
  // caller's own choice alone while still reaching everything that choice creates below it.
  return {
    create: (): Promise<unknown> => (row ??= factory.create()),
    [brand]: factory[brand],
    [chosen]: true,
  };
}

// The parent stays inert here rather than being created: a layer whose relation field a later layer
// overwrites is dropped by the merge, and only what the merge leaves standing is ever evaluated.
function relationStep(wiring: Wiring, model: string, { parent, relationField }: Relation): Step {
  const field = isFactory(parent)
    ? resolveRelationField(wiring.client, model, parent[brand], relationField)
    : resolveRowRelationField(wiring.client, model, parent, relationField);
  const value = shared(wiring, parent);

  return (): Written => ({ [field]: value });
}

// A list holding no row stands for no model, which is what a named field is checked without and what
// an omitted one cannot be resolved from at all.
function attachField(client: unknown, model: string, { children, relationField }: Children): string | undefined {
  if (isFactory(children)) return resolveRelationField(client, model, children[brand], relationField);

  const [first] = listed(children) as (Record<string, unknown> | undefined)[];

  if (first !== undefined) return resolveRowRelationField(client, model, first, relationField);

  return relationField === undefined ? undefined : namedRelationField(client, model, relationField);
}

// The name the escape hatch carries is checked against the relation fields the child model points
// back with, never through the pairing metadata, which is the one lookup it exists to route around.
// Only a child factory ever reaches back, so the form connecting rows has no name to check.
function attachInverse(client: unknown, model: string, { children, inverse }: Children): string | undefined {
  if (inverse === undefined || !isFactory(children)) return inverse;

  return resolveRelationField(client, children[brand], model, inverse);
}

// A layer naming no relation field leaves it exactly as the layers around it leave it; one naming a
// field with nothing to connect writes an entry the parent's own create then finds empty.
function attachStep({ client }: Wiring, model: string, layer: Children, order: number): Step {
  const field = attachField(client, model, layer);

  if (field === undefined) return (): Written => ({});

  const entry: Attachment = { children: layer.children, inverse: attachInverse(client, model, layer), order };

  return ({ attrs }): Written => ({ [field]: accumulating(attrs[field], entry) });
}

// A relation field and its foreign key columns are one key to the merge: a later layer writing either
// drops what an earlier one wrote under the other, while a layer naming both keeps both for Prisma to
// refuse. Only a layer holding a value that may stand in a relation field can pair anything, so the
// metadata is read for no other — a client carrying none still creates a model holding no relation.
function overlaid(earlier: Written, later: Written, pairing: () => Pairing): Written {
  const layers = [earlier, later].flatMap((layer) => Object.values(layer));

  if (!layers.some((value) => standing(value) !== undefined)) return { ...earlier, ...later };

  const displaced = new Set(
    pairing().flatMap(([field, { fields }]) => [
      ...(fields.some((column) => column in later) ? [field] : []),
      ...(field in later ? fields : []),
    ]),
  );

  return { ...Object.fromEntries(Object.entries(earlier).filter(([key]) => !displaced.has(key))), ...later };
}

function layerStep(wiring: Wiring, model: string, layer: Layer, order: number): Step {
  if (typeof layer === "function") return layer;

  return "children" in layer ? attachStep(wiring, model, layer, order) : relationStep(wiring, model, layer);
}

async function write<C, M extends ModelName<C>>(
  chain: FactoryChain<C, M>,
  overrides: Written | undefined,
): Promise<unknown[]> {
  // One faker serves the whole batch, so a seeded run replays the same values in the same order.
  const faker = await chain.faker();
  const client = chain.client();
  const model = String(chain.model);
  const wiring: Wiring = { client, pool: chain.pool, pick: chain.pick, drawnInto: [], matchedInto: [] };
  // Every model the client carries, which is what a callback reaches a second one through. `using`
  // asks for a single delegate, so a chain redirected to a stub carrying fewer stands on the caller.
  const reached = { client: client as Pick<C, ModelName<C>> };
  const delegate = presentDelegate(client, model) as CreateDelegate;
  const applied = given(overrides);
  // A relation field the call names outright is the caller's own choice of parent, which the pool
  // leaves standing; a key valued `undefined` names nothing, `given` having dropped it.
  const explicit = new Set(Object.keys(applied));
  const steps = chain.applied.map((layer, order) => layerStep(wiring, model, layer, order));
  let paired: Pairing | undefined;
  const pairing = (): Pairing => (paired ??= pairingOf(client, model));
  const rows: unknown[] = [];

  for (let index = 0; index < (chain.batch ?? 1); index += 1) {
    const context = { faker, index, uid: nextUid(), parent: chain.parent };
    let attrs = given(chain.definition(context));

    for (const state of steps) attrs = overlaid(attrs, given(state({ ...context, attrs })), pairing);

    const { data, pending } = await resolved(wiring, model, overlaid(attrs, applied, pairing), explicit);
    const row = await persisted(delegate, data, wiring, model);

    // Depth first: every child of one record exists before the next record of the batch is created,
    // the children a relation field's own value left pending ahead of the ones the `has` layers add,
    // and those in the order the calls were made.
    for (const entry of pending) await borne(wiring, model, row, entry);

    // The graph under this record stands complete here, and each callback settles before the next
    // begins, so one holding the record open never overlaps the one behind it.
    for (const callback of chain.callbacks) await callback(row as Row<C, M>, reached);

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
 * It carries `Symbol.for("prisma-factorio.recycle")` the same way, valued with an object whose `draw`
 * takes a pool and a picker and hands back this factory drawing from them, its own pooled rows kept.
 * Resolving a relation calls it, which is what spreads one `recycle` over a graph. The same object
 * reports this chain's batch size as `batch`, which is how many rows a `has` layer — or a relation
 * field holding many records — draws in place of the records it would have created.
 *
 * Its `create` reads `Symbol.for("prisma-factorio.created")` on a relation field's value in the
 * overrides: a native `{ connect }` carrying that key holds, under it, the row the build created a
 * moment ago, which the create may write as its foreign key instead. A `has` layer hands each child
 * one, the parent row under that key.
 *
 * @example
 * ```ts
 * const userFactory = createFactory<PrismaClient, "user", Row<PrismaClient, "user">, object>(chain);
 * ```
 */
export function createFactory<C, M extends ModelName<C>, R, S>(chain: FactoryChain<C, M>): Factory<C, M, R, S> {
  const derive = (layer: Layer): Factory<C, M, R, S> => createFactory({ ...chain, applied: [...chain.applied, layer] });

  const methods: FactoryMethods<C, M, R, S> = {
    async create(overrides?: unknown): Promise<R> {
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
      const [first] = args;
      // Read off the tail rather than off a position: a relation field the model pair leaves skippable
      // may still be passed, valued `undefined`, with the options behind it.
      const tail: unknown = args.at(-1);
      const options = (typeof tail === "object" ? tail : undefined) as HasOptions | null | undefined;

      return derive({
        children,
        relationField: typeof first === "string" ? first : undefined,
        inverse: options?.inverse,
      });
    },
    recycle(model: ModelName<C>, rows: unknown): Factory<C, M, R, S> {
      return createFactory({ ...chain, pool: recycledPool(chain.pool, String(model), rows) });
    },
    afterCreating(callback: AfterCreating<C, M>): Factory<C, M, R, S> {
      return createFactory({ ...chain, callbacks: [...chain.callbacks, callback] });
    },
  };

  const named = Object.entries(chain.declared).map(([name, state]) => [name, (): Factory<C, M, R, S> => derive(state)]);
  const factory = { ...methods, ...Object.fromEntries(named) } as Factory<C, M, R, S>;

  // The chain resolving a relation holds the whole client rather than one delegate, so the client it
  // hands over serves this factory's model as well as its own.
  const inherit = (client: unknown): Factory<C, M, R, S> =>
    chain.explicit ? factory : createFactory({ ...chain, client: () => client as Pick<C, M> });
  const bear = (parent: unknown): Factory<C, M, R, S> => createFactory({ ...chain, parent });
  // The rows a chain pools stack up rather than replace the ones this factory pools itself, the same
  // reading two `recycle` calls on one chain take; the picker is the resolving graph's, so one stream
  // covers every pick the graph makes, in the order it makes them. A graph pooling nothing and drawing
  // on this factory's own stream leaves it exactly as it stands, which is every graph no `recycle`
  // call was ever made on.
  const draw = (pool: Pool, pick: Picker): Factory<C, M, R, S> =>
    Object.keys(pool).length === 0 && pick === chain.pick
      ? factory
      : createFactory({ ...chain, pool: mergedPool(chain.pool, pool), pick });

  Object.defineProperty(factory, brand, { value: String(chain.model) });
  Object.defineProperty(factory, rebind, { value: inherit });
  Object.defineProperty(factory, recycler, { value: { draw, batch: chain.batch } });

  return Object.defineProperty(factory, bearer, { value: bear });
}
