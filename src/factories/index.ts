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

/**
 * A factory subclass constructible with no arguments, as stored in the
 * default-factory registry.
 *
 * @example
 * const factories: Record<string, RegisterableFactory> = { Post: PostFactory };
 */
export type RegisterableFactory = new () => Factory<unknown, unknown, unknown>;

const registeredFactories = new Map<string, RegisterableFactory>();

/**
 * Registers the default factory to build a model's children when a magic
 * relationship method is called in short form (`hasPosts(3)` /
 * `forAuthor({ … })`), keyed by model name. Merges into the registry, the last
 * registration winning per model. The typed wrapper of the same name in the
 * generated barrel narrows the keys and values to the schema's factories;
 * prefer it over this untyped runtime function.
 *
 * @example
 * registerFactories({ User: UserFactory, Post: PostFactory });
 */
export function registerFactories(factories: Record<string, RegisterableFactory>): void {
  for (const [model, factory] of Object.entries(factories)) {
    registeredFactories.set(model, factory);
  }
}

/**
 * Thrown when a short-form magic relationship method needs a model's default
 * factory and none was registered. The message names the model and both ways
 * out: register the factory, or pass a configured one.
 *
 * @example
 * expect(() => resolveRegisteredFactory("Post")).toThrow(FactoryNotRegisteredError);
 */
export class FactoryNotRegisteredError extends Error {
  constructor(modelName: string) {
    super(
      `No factory is registered for model "${modelName}". A short-form magic relationship ` +
        `method needs the target model's factory to build its children. Register it once at ` +
        `startup — registerFactories({ ${modelName}: ${modelName}Factory }) — or pass a ` +
        `configured factory instead, e.g. hasPosts(${modelName}Factory.new().count(3)).`,
    );
    this.name = "FactoryNotRegisteredError";
  }
}

/**
 * Resolves a fresh instance of the factory registered for `modelName`, used by
 * the generated magic methods to build children in their short forms. Throws
 * {@link FactoryNotRegisteredError} when the model has no registered factory.
 *
 * @example
 * registerFactories({ Post: PostFactory });
 * const child = resolveRegisteredFactory("Post"); // a fresh PostFactory
 */
export function resolveRegisteredFactory(modelName: string): Factory<unknown, unknown, unknown> {
  const ctor = registeredFactories.get(modelName);
  if (ctor === undefined) {
    throw new FactoryNotRegisteredError(modelName);
  }
  assertZeroArgConstructor(ctor);
  return new ctor();
}

/**
 * Thrown when a `forX(overrides)` call has no default factory to override: the
 * factory's definition holds plain data (or nothing) for that relation instead
 * of a factory-as-value. The message names the relation and how to fix it.
 *
 * @example
 * // Post's definition sets `author` to a connect object, not a factory:
 * expect(() => PostFactory.new().forAuthor({ name: "X" }).make()).toThrow(RelationDefaultFactoryError);
 */
export class RelationDefaultFactoryError extends Error {
  constructor(field: string, methodName: string) {
    super(
      `Cannot apply overrides through ${methodName}(): the definition value for relation "${field}" is ` +
        `not a factory, so there is no default factory to apply the overrides to. Set "${field}" to a ` +
        `factory-as-value in the definition, or pass a factory or an existing row to ${methodName}() instead.`,
    );
    this.name = "RelationDefaultFactoryError";
  }
}

/**
 * A relation field's value inside a {@link Factory.definition}: the related
 * model's factory directly, or a thunk returning it. The thunk form exists
 * only to break a TypeScript import cycle between two factory files; mutual
 * definition references are otherwise legitimate. Either form resolves lazily
 * at {@link Factory.make} / {@link Factory.create} time to a nested
 * `{ create: <the child's evaluated CreateInput> }`.
 *
 * @example
 * definition() {
 *   return { title: "Hello", author: UserFactory.new() };          // eager
 *   // return { title: "Hello", author: () => UserFactory.new() }; // lazy
 * }
 */
export type FactoryValue<TFactory extends Factory<unknown, unknown, unknown>> = TFactory | (() => TFactory);

/**
 * Rejection of {@link Factory.make} / {@link Factory.create} when a
 * factory-as-value definition references, directly or transitively, a factory
 * already being resolved higher in the same tree — an unresolvable cycle that
 * would otherwise overflow the stack. The message names the factories in the
 * cycle in resolution order.
 *
 * @example
 * // ChickenFactory's definition uses EggFactory and vice-versa:
 * expect(() => ChickenFactory.new().make()).toThrow(FactoryCycleError);
 */
export class FactoryCycleError extends Error {
  constructor(cycle: readonly { name: string }[]) {
    const names = cycle.map((constructor) => constructor.name).join(" → ");
    super(
      `Factory-as-value cycle detected: ${names}. A definition whose factory-as-value leads back to a factory already being resolved cannot terminate; break the cycle by supplying that relation through a state or overrides.`,
    );
    this.name = "FactoryCycleError";
  }
}

/**
 * The parent's evaluated attributes, passed as the second argument to a child's
 * state closures when the child is born through a magic relationship method. A
 * factory cannot know which parent will nest it, so this defaults to a loose
 * record; annotate the parameter with the parent's `CreateInput` at the call
 * site to recover types. At the top level (no nesting) it is an empty object.
 *
 * @example
 * PostFactory.new().state((attrs, parent: UserCreateInput) => ({ title: `by ${parent.name}` }));
 */
export type ParentAttributes = Record<string, unknown>;

/**
 * What {@link Factory.state} (and the overrides argument of
 * {@link Factory.make} / {@link Factory.create}) accepts: a partial of the
 * factory's definition type, or a closure computing one from the attributes
 * evaluated so far in the chain (definition plus earlier states). The closure's
 * second argument is the {@link ParentAttributes} of the nesting parent, only
 * populated for a child born through a magic relationship method. For a model
 * with relations the definition type widens each relation field to also accept
 * a {@link FactoryValue}, so a closure may observe an unresolved factory there.
 *
 * @example
 * UserFactory.new().state({ name: "Abigail Otwell" });
 * UserFactory.new().state((attrs) => ({ email: `${attrs.name}@example.com` }));
 */
export type StateInput<TCreateInput, TParent = ParentAttributes> =
  Partial<TCreateInput> | ((attributes: TCreateInput, parent: TParent) => Partial<TCreateInput>);

function isStateClosure<TCreateInput, TParent>(
  input: StateInput<TCreateInput, TParent>,
): input is (attributes: TCreateInput, parent: TParent) => Partial<TCreateInput> {
  return typeof input === "function";
}

/**
 * What {@link Factory.sequence} accepts: one or more partials cycled over by
 * instance index, or a single closure computing the partial from the 0-based
 * index. Sequence says what varies per instance; it never sets how many
 * instances there are — that is {@link Factory.count}.
 *
 * @example
 * UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" });
 * UserFactory.new().count(10).sequence((i) => ({ name: `User ${i}` }));
 */
export type SequenceInput<TCreateInput> =
  readonly [Partial<TCreateInput>, ...Partial<TCreateInput>[]] | readonly [(index: number) => Partial<TCreateInput>];

// Declared with method syntax so the attributes parameter checks bivariantly:
// a bare function type would make `states` contravariant in TCreateInput and
// concrete factories would stop satisfying the Factory<unknown, unknown>
// constraint of Factory.new().
type PipelineStep<TCreateInput> = {
  step(attributes: TCreateInput, index: number, parent: ParentAttributes): Partial<TCreateInput>;
}["step"];

function toPipelineStep<TCreateInput>(input: StateInput<TCreateInput>): PipelineStep<TCreateInput> {
  return (attributes, _index, parent) => (isStateClosure(input) ? input(attributes, parent) : input);
}

function sequenceStepAt<TCreateInput>(steps: SequenceInput<TCreateInput>): (index: number) => Partial<TCreateInput> {
  const [first] = steps;
  if (typeof first === "function") {
    return first;
  }
  const values = steps as readonly Partial<TCreateInput>[];
  return (index) => values[index % values.length] ?? {};
}

function assertZeroArgConstructor(ctor: new () => unknown): void {
  // A bare construct-signature type does not structurally carry Function's
  // length/name, so reading them is the single untyped boundary here. `length`
  // counts exactly the required parameters — default and rest parameters do
  // not add to it.
  const fn = ctor as unknown as { length: number; name: string };
  if (fn.length > 0) {
    throw new TypeError(
      `${fn.name} declares ${String(fn.length)} required constructor parameter(s). Factory chains fork by fresh construction, so factory classes must be constructible with no arguments — pin per-factory values with class fields or named states instead.`,
    );
  }
}

interface DelegateLike {
  create(args: { data: unknown; include?: unknown }): Promise<unknown>;
}

// A relation declared on the chain by a magic method (`hasX` / `forX`), carried
// through forks alongside the state pipeline. `build` turns the parent's
// evaluated attributes into the Prisma nested-write value for `field`; `include`
// is what that field contributes to the create call's `include`, so the
// declared relation reaches the typed return.
interface RelationDeclaration {
  field: string;
  include: unknown;
  build(parentAttributes: Record<string, unknown>, lineage: ReadonlySet<FactoryConstructor>): unknown;
}

// Merges the `include` contributions of several children of one to-many
// relation into a single value: `true` when no child loaded sub-relations,
// otherwise a `{ include }` whose map unions every child's loaded relations.
function mergeIncludeValues(values: readonly unknown[]): unknown {
  const merged: Record<string, unknown> = {};
  let nested = false;
  for (const value of values) {
    if (typeof value === "object" && value !== null && "include" in value) {
      nested = true;
      Object.assign(merged, (value as { include: Record<string, unknown> }).include);
    }
  }
  return nested ? { include: merged } : true;
}

// A factory subclass constructor, keyed by identity for cycle detection and
// carrying `name` for the FactoryCycleError message.
type FactoryConstructor = (new () => Factory<unknown, unknown, unknown>) & { name: string };

// A factory-as-value is either the factory itself or a thunk returning one.
// Any other value — including a caller-supplied relation object — is not a
// factory and returns undefined, so resolution leaves it untouched. A
// top-level function value only ever appears as the thunk form here, since a
// CreateInput never holds a function.
function asFactory(value: unknown): Factory<unknown, unknown, unknown> | undefined {
  const candidate = typeof value === "function" ? (value as () => unknown)() : value;
  return candidate instanceof Factory ? candidate : undefined;
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
 * Instances are immutable: no method mutates the factory, so chain steps
 * like {@link Factory.state} return copies instead of modifying `this`.
 *
 * Subclasses must be constructible with no arguments and hold no mutable
 * per-instance state: a chain step forks by fresh construction, so only the
 * pipeline carries over — anything set through a constructor parameter is lost
 * on the first fork. Pin per-factory values with class field initializers or
 * named states instead. A required constructor parameter throws a `TypeError`
 * at the first fork rather than silently producing wrong data.
 *
 * @example
 * class UserFactory extends UserFactoryBase {
 *   definition() {
 *     return { email: "ada@example.com", role: Role.ADMIN };
 *   }
 * }
 * const user = await UserFactory.new().create();
 */
export abstract class Factory<TCreateInput, TModel, TDefinition = TCreateInput, TResult = TModel> {
  /**
   * Name of the Prisma client delegate {@link Factory.create} persists
   * through — the model name with its first letter lowercased. Baked into
   * every generated base class because the schema is unavailable at runtime.
   *
   * @example
   * protected readonly prismaDelegate = "user";
   */
  protected abstract readonly prismaDelegate: string;

  private states: readonly PipelineStep<TDefinition>[] = [];

  private relations: readonly RelationDeclaration[] = [];

  /**
   * Declares the default attributes of the model. Called once per
   * {@link Factory.make}, so values are computed fresh for every record. A
   * relation field may hold a {@link FactoryValue} of the related model, which
   * resolves to a nested create at make time.
   *
   * @example
   * definition() {
   *   return { email: `user-${crypto.randomUUID()}@example.com`, role: Role.MEMBER };
   * }
   */
  abstract definition(): TDefinition;

  /**
   * Creates a factory instance; the entry point of every factory chain.
   *
   * @example
   * const factory = UserFactory.new();
   */
  static new<TFactory extends Factory<unknown, unknown>>(this: new () => TFactory): TFactory {
    assertZeroArgConstructor(this);
    return new this();
  }

  /**
   * Appends a state to the chain and returns a copy of the factory; the
   * receiver is untouched. Nothing evaluates until {@link Factory.make} or
   * {@link Factory.create}. Named states are this same method called from a
   * factory method; inline call-site states call it directly.
   *
   * @example
   * // Named state in a factory class:
   * suspended() {
   *   return this.state({ status: "suspended" });
   * }
   * @example
   * // Inline at the call site, closure form reading earlier attributes:
   * UserFactory.new().state({ name: "Ada" }).state((attrs) => ({ email: `${attrs.name}@example.com` }));
   */
  state(input: StateInput<TDefinition>): this {
    return this.fork(toPipelineStep(input));
  }

  /**
   * Appends a cyclic, index-driven state at this chain position and returns a
   * copy of the factory. Partials are cycled over the 0-based instance index
   * (`index % values.length`); the closure form computes the partial from that
   * index. Sequence never sets how many instances there are: without
   * {@link Factory.count} a single instance is built and only the first value
   * is used.
   *
   * @example
   * // 5 admins, 5 members:
   * await UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" }).create();
   * @example
   * await UserFactory.new().count(10).sequence((i) => ({ name: `User ${String(i)}` })).create();
   */
  sequence(step: (index: number) => Partial<TDefinition>): this;
  sequence(...values: [Partial<TDefinition>, ...Partial<TDefinition>[]]): this;
  sequence(...steps: SequenceInput<TDefinition>): this {
    const stepAt = sequenceStepAt(steps);
    return this.fork((_attributes, index) => stepAt(index));
  }

  private fork(step: PipelineStep<TDefinition>): this {
    return this.forkInto([...this.states, step], this.relations);
  }

  // Forks by fresh construction, carrying only the chain state — the state
  // pipeline and the declared relations. Fresh construction installs subclass
  // class fields on the copy itself, so arrow-function named states stay bound
  // to the copy and native #private fields keep working; bulk-copying the rest
  // would carry arrow fields still bound to the receiver. It only holds when the
  // subclass takes no constructor arguments, so the guard fires here, the first
  // moment a fork happens.
  private forkInto(states: readonly PipelineStep<TDefinition>[], relations: readonly RelationDeclaration[]): this {
    const ctor = this.constructor as new () => this;
    assertZeroArgConstructor(ctor);
    const copy = new ctor();
    copy.states = states;
    copy.relations = relations;
    return copy;
  }

  /**
   * Builds the model's `CreateInput` synchronously by running the whole
   * pipeline: {@link Factory.definition} first, then states in chain order,
   * then `overrides` last — shallow merge, last value wins per field.
   * Everything, definition included, is re-evaluated on each call.
   *
   * @example
   * const input = UserFactory.new().suspended().make({ name: "Ada" });
   */
  make(overrides?: StateInput<TDefinition>): TCreateInput {
    return this.makeAt(0, overrides);
  }

  private makeAt(index: number, overrides?: StateInput<TDefinition>): TCreateInput {
    return this.buildInput(index, overrides, {}, new Set([this.constructor as FactoryConstructor]));
  }

  // The single build path: evaluate the pipeline (threading the nesting parent
  // into closures), fold in the declared magic relations, then resolve any
  // remaining factory-as-values. `lineage` already contains this factory's
  // constructor on entry, so a definition cycling straight back to it is caught.
  private buildInput(
    index: number,
    overrides: StateInput<TDefinition> | undefined,
    parent: ParentAttributes,
    lineage: ReadonlySet<FactoryConstructor>,
  ): TCreateInput {
    const attributes = this.evaluate(index, overrides, parent);
    const withRelations = this.applyRelations(attributes, lineage);
    return this.resolve(withRelations, lineage);
  }

  private evaluate(
    index: number,
    overrides: StateInput<TDefinition> | undefined,
    parent: ParentAttributes,
  ): TDefinition {
    const pipeline = overrides === undefined ? this.states : [...this.states, toPipelineStep(overrides)];
    return pipeline.reduce<TDefinition>(
      (attributes, step) => ({ ...attributes, ...step(attributes, index, parent) }),
      this.definition(),
    );
  }

  // Overwrites each magic-declared relation field with its Prisma nested-write
  // value. Running before resolve, this both short-circuits the definition's
  // own factory-as-value for that field (it is replaced by plain write data the
  // resolver leaves untouched) and hands each child the parent's evaluated
  // attributes.
  private applyRelations(attributes: TDefinition, lineage: ReadonlySet<FactoryConstructor>): TDefinition {
    if (this.relations.length === 0) {
      return attributes;
    }
    const merged = { ...attributes } as Record<string, unknown>;
    for (const relation of this.relations) {
      merged[relation.field] = relation.build(merged, lineage);
    }
    return merged as TDefinition;
  }

  // Turns the evaluated definition into a CreateInput by replacing every
  // top-level factory-as-value with its nested `{ create: … }`. Values the
  // pipeline already resolved to plain data (a caller-supplied relation, or a
  // magic-declared relation) are not factories, so they pass through untouched
  // — the short-circuit rule.
  private resolve(attributes: TDefinition, lineage: ReadonlySet<FactoryConstructor>): TCreateInput {
    const source = attributes as Record<string, unknown>;
    const resolved: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      resolved[key] = this.resolveValue(source[key], lineage);
    }
    return resolved as TCreateInput;
  }

  private resolveValue(value: unknown, lineage: ReadonlySet<FactoryConstructor>): unknown {
    const factory = asFactory(value);
    if (factory === undefined) {
      return value;
    }
    return { create: this.buildChild(factory, {}, undefined, 0, lineage) };
  }

  // Builds one nested child input under an extended lineage: guards the cycle,
  // runs the child's own full build with `parent` as its closures' second
  // argument, then drops `inverseField` so a child born through a to-many magic
  // method does not re-create the parent it is already nested under.
  private buildChild(
    factory: Factory<unknown, unknown, unknown>,
    parent: ParentAttributes,
    inverseField: string | undefined,
    index: number,
    lineage: ReadonlySet<FactoryConstructor>,
  ): unknown {
    const constructor = factory.constructor as FactoryConstructor;
    if (lineage.has(constructor)) {
      throw new FactoryCycleError([...lineage, constructor]);
    }
    const input = factory.buildInput(index, undefined, parent, new Set(lineage).add(constructor)) as Record<
      string,
      unknown
    >;
    if (inverseField !== undefined && inverseField in input) {
      // Drop the child's back-reference to this parent: the nesting already
      // links them, so keeping the child's own factory-as-value there would
      // create a second parent.
      const withoutBackReference: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (key !== inverseField) {
          withoutBackReference[key] = input[key];
        }
      }
      return withoutBackReference;
    }
    return input;
  }

  // Appends a to-one relation (`forX`) to the chain. The value is resolved at
  // build time: an existing row connects, a factory nests a create, and a plain
  // overrides object is applied as a state to the definition's factory-as-value
  // for that relation.
  protected declareToOne(field: string, targetModel: string, idField: string, methodName: string, arg: unknown): this {
    const include = arg instanceof Factory ? arg.includeValue() : true;
    const declaration: RelationDeclaration = {
      field,
      include,
      build: (parentAttributes, lineage) => this.buildToOne(field, idField, methodName, arg, parentAttributes, lineage),
    };
    return this.forkInto(this.states, [...this.relations, declaration]);
  }

  private buildToOne(
    field: string,
    idField: string,
    methodName: string,
    arg: unknown,
    parentAttributes: Record<string, unknown>,
    lineage: ReadonlySet<FactoryConstructor>,
  ): unknown {
    if (arg instanceof Factory) {
      return { create: this.buildChild(arg, parentAttributes, undefined, 0, lineage) };
    }
    const record = arg as Record<string, unknown>;
    if (idField in record && record[idField] !== undefined) {
      return { connect: { [idField]: record[idField] } };
    }
    const defaultFactory = asFactory(parentAttributes[field]);
    if (defaultFactory === undefined) {
      throw new RelationDefaultFactoryError(field, methodName);
    }
    const configured = defaultFactory.state(record);
    return { create: this.buildChild(configured, parentAttributes, undefined, 0, lineage) };
  }

  // Appends a to-many relation (`hasX`) to the chain. `inverseField` is the
  // child's back-reference to this parent, dropped from each built child.
  protected declareToMany(
    field: string,
    targetModel: string,
    inverseField: string,
    arg: unknown,
    overrides: unknown,
  ): this {
    const include = this.toManyIncludeValue(arg);
    const declaration: RelationDeclaration = {
      field,
      include,
      build: (parentAttributes, lineage) =>
        this.buildToMany(targetModel, inverseField, arg, overrides, parentAttributes, lineage),
    };
    return this.forkInto(this.states, [...this.relations, declaration]);
  }

  private buildToMany(
    targetModel: string,
    inverseField: string,
    arg: unknown,
    overrides: unknown,
    parentAttributes: Record<string, unknown>,
    lineage: ReadonlySet<FactoryConstructor>,
  ): unknown {
    const requests = resolveChildRequests(targetModel, arg, overrides);
    const create = requests.map((request) =>
      this.buildChild(request.factory, parentAttributes, inverseField, request.index, lineage),
    );
    return { create };
  }

  // What a to-many relation's declared children contribute to the create call's
  // `include`: `true` for the registry short forms and for children with no
  // magic chain of their own, otherwise the child chain's own nested include.
  private toManyIncludeValue(arg: unknown): unknown {
    if (arg instanceof ListFactory) {
      return arg.underlyingFactory().includeValue();
    }
    if (arg instanceof Factory) {
      return arg.includeValue();
    }
    if (Array.isArray(arg)) {
      return mergeIncludeValues(arg.map((factory: Factory<unknown, unknown, unknown>) => factory.includeValue()));
    }
    return true;
  }

  // This chain's contribution as a nested include value: `true` when it declared
  // no relations, otherwise `{ include: <its relation map> }`.
  private includeValue(): unknown {
    const map = this.includeMap();
    return map === undefined ? true : { include: map };
  }

  // The `include` map of the relations this chain declared, or undefined when it
  // declared none.
  private includeMap(): Record<string, unknown> | undefined {
    if (this.relations.length === 0) {
      return undefined;
    }
    const map: Record<string, unknown> = {};
    for (const relation of this.relations) {
      map[relation.field] = relation.include;
    }
    return map;
  }

  /**
   * Sets how many instances the factory produces and flips the chain to the
   * list-typed {@link ListFactory}: `make()` returns `TCreateInput[]` and
   * `create()` resolves `TModel[]`. Count says how many, never what varies —
   * pair it with {@link Factory.sequence} for per-instance variation. The
   * receiver is untouched; `n` must be a non-negative integer.
   *
   * @example
   * const users = await UserFactory.new().count(3).create(); // User[]
   */
  count(n: number): ListFactory<TCreateInput, TModel, TDefinition, TResult> {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`count() needs a non-negative integer, got ${String(n)}.`);
    }
    // The bound builders carry the private per-index pipeline into the list
    // factory without widening the visibility of makeAt/createAt.
    return new ListFactory(
      this,
      n,
      (index, overrides) => this.makeAt(index, overrides),
      (index, overrides) => this.createAt(index, overrides),
    );
  }

  /**
   * Persists one record through the Prisma client registered with
   * {@link initPrismaFactorio} and resolves with the persisted row. The
   * `overrides` argument is applied as a final state, exactly as
   * `.state(overrides).create()`.
   *
   * @example
   * const user = await UserFactory.new().create({ name: "Abigail" }); // row persisted via prisma.user.create
   */
  async create(overrides?: StateInput<TDefinition>): Promise<TResult> {
    return this.createAt(0, overrides);
  }

  private async createAt(index: number, overrides?: StateInput<TDefinition>): Promise<TResult> {
    // The registry cannot carry concrete client types; the generated base
    // pins prismaDelegate and TResult to the same model, so this single cast
    // is the whole untyped boundary.
    const delegates = resolveClient() as Record<string, DelegateLike | undefined>;
    const delegate = delegates[this.prismaDelegate];
    if (delegate === undefined) {
      throw new TypeError(
        `The registered Prisma client has no "${this.prismaDelegate}" delegate; pass the client generated for this schema to initPrismaFactorio.`,
      );
    }
    const data = this.makeAt(index, overrides);
    // Every relation the chain declared is loaded back, so the persisted row
    // carries exactly the tree the return type promises.
    const include = this.includeMap();
    const args = include === undefined ? { data } : { data, include };
    return delegate.create(args) as Promise<TResult>;
  }
}

/**
 * A factory chain that produces a fixed number of instances; entered through
 * {@link Factory.count}, never constructed directly. The chain primitives keep
 * working at their position — each returns a new list factory over a forked
 * copy of the underlying factory, so immutability holds — and `make()` /
 * `create()` produce lists instead of single values.
 *
 * @example
 * const users = await UserFactory.new().count(3).create(); // User[]
 */
export class ListFactory<TCreateInput, TModel, TDefinition = TCreateInput, TResult = TModel> {
  constructor(
    private readonly factory: Factory<TCreateInput, TModel, TDefinition, TResult>,
    private readonly instances: number,
    private readonly makeAt: (index: number, overrides?: StateInput<TDefinition>) => TCreateInput,
    private readonly createAt: (index: number, overrides?: StateInput<TDefinition>) => Promise<TResult>,
  ) {}

  /**
   * The underlying single factory, used by a parent's to-many magic method to
   * build this list as nested children. Internal to the runtime.
   *
   * @example
   * UserFactory.new().hasPosts(PostFactory.new().count(3)); // reads the list's factory
   */
  underlyingFactory(): Factory<TCreateInput, TModel, TDefinition, TResult> {
    return this.factory;
  }

  /**
   * How many instances this list produces, used alongside
   * {@link ListFactory.underlyingFactory} when nesting the list as children.
   * Internal to the runtime.
   *
   * @example
   * UserFactory.new().hasPosts(PostFactory.new().count(3)); // reads the count 3
   */
  size(): number {
    return this.instances;
  }

  /**
   * Replaces how many instances the chain produces — the last count wins.
   *
   * @example
   * UserFactory.new().count(5).count(2).make(); // 2 inputs
   */
  count(n: number): ListFactory<TCreateInput, TModel, TDefinition, TResult> {
    return this.factory.count(n);
  }

  /**
   * Appends a state at this chain position, exactly like {@link Factory.state},
   * keeping the instance count.
   *
   * @example
   * UserFactory.new().count(3).state({ role: "admin" }).make();
   */
  state(input: StateInput<TDefinition>): ListFactory<TCreateInput, TModel, TDefinition, TResult> {
    return this.factory.state(input).count(this.instances);
  }

  /**
   * Appends a cyclic, index-driven state at this chain position, exactly like
   * {@link Factory.sequence}, keeping the instance count.
   *
   * @example
   * UserFactory.new().count(10).sequence({ role: "admin" }, { role: "member" }).make();
   */
  sequence(step: (index: number) => Partial<TDefinition>): ListFactory<TCreateInput, TModel, TDefinition, TResult>;
  sequence(
    ...values: [Partial<TDefinition>, ...Partial<TDefinition>[]]
  ): ListFactory<TCreateInput, TModel, TDefinition, TResult>;
  sequence(...steps: SequenceInput<TDefinition>): ListFactory<TCreateInput, TModel, TDefinition, TResult> {
    return this.factory.sequence(sequenceStepAt(steps)).count(this.instances);
  }

  /**
   * Builds one `CreateInput` per instance. The whole pipeline — definition,
   * states, `overrides` — is re-evaluated for each instance, so random values
   * differ across the list.
   *
   * @example
   * const inputs = UserFactory.new().count(3).make(); // UserCreateInput[]
   */
  make(overrides?: StateInput<TDefinition>): TCreateInput[] {
    return Array.from({ length: this.instances }, (_, index) => this.makeAt(index, overrides));
  }

  /**
   * Persists one record per instance through n individual `create` calls, run
   * sequentially, and resolves with the rows in creation order. The calls are
   * not wrapped in a transaction — a mid-batch failure leaves the earlier rows
   * persisted; wrap the call in `$transaction` yourself when that matters.
   *
   * @example
   * const users = await prisma.$transaction(() => UserFactory.new().count(3).create());
   */
  async create(overrides?: StateInput<TDefinition>): Promise<TResult[]> {
    const rows: TResult[] = [];
    for (let index = 0; index < this.instances; index += 1) {
      rows.push(await this.createAt(index, overrides));
    }
    return rows;
  }
}

interface ChildRequest {
  factory: Factory<unknown, unknown, unknown>;
  index: number;
}

// Normalizes a to-many magic method's argument into one build request per
// child: a count draws from the registered default factory (with the uniform
// overrides applied), a list factory expands to its instance count, a single
// factory is one child, and an array is one child per element.
function resolveChildRequests(targetModel: string, arg: unknown, overrides: unknown): ChildRequest[] {
  if (typeof arg === "number") {
    const base = applyChildOverrides(resolveRegisteredFactory(targetModel), overrides);
    return Array.from({ length: arg }, (_unused, index) => ({ factory: base, index }));
  }
  if (arg instanceof ListFactory) {
    const factory = arg.underlyingFactory() as Factory<unknown, unknown, unknown>;
    return Array.from({ length: arg.size() }, (_unused, index) => ({ factory, index }));
  }
  if (arg instanceof Factory) {
    return [{ factory: arg, index: 0 }];
  }
  if (Array.isArray(arg)) {
    return (arg as Factory<unknown, unknown, unknown>[]).map((factory, index) => ({ factory, index }));
  }
  throw new TypeError("A to-many magic method expects a count, a factory, a list factory, or an array of factories.");
}

function applyChildOverrides(
  factory: Factory<unknown, unknown, unknown>,
  overrides: unknown,
): Factory<unknown, unknown, unknown> {
  return overrides === undefined ? factory : factory.state(overrides as StateInput<unknown>);
}
