import type { Types } from "@prisma/client/runtime/client";
import type { Factory } from "./factory.js";

/**
 * The model names a client carries, as accepted by `define`.
 *
 * Read structurally off the client rather than from the generated `Prisma` namespace, which this
 * package cannot name: only the user's own generated client exports it.
 *
 * @example
 * ```ts
 * type Model = ModelName<PrismaClient>; // "user" | "post"
 * ```
 */
export type ModelName<C> = {
  [K in keyof C]: C[K] extends { create: (...args: never[]) => unknown } ? K : never;
}[keyof C];

/**
 * The row a model's `create` returns: every scalar the model holds, none of its relations.
 *
 * @example
 * ```ts
 * const row: Row<PrismaClient, "user"> = { id: 1, email: "ada@example.com", name: null };
 * ```
 */
export type Row<C, M extends ModelName<C>> = Types.Public.Result<C[M], object, "create">;

// `Payload` takes a deferred generic and answers `any` for anything that is not a delegate.
type Objects<C, M extends ModelName<C>> = Types.Public.Payload<C[M]> extends { objects: infer O } ? O : never;

type ModelTag<C, M extends ModelName<C>> = Types.Public.Payload<C[M]> extends { name: infer N } ? N : never;

type Unwrap<T> = T extends readonly (infer E)[] ? E : T;

/**
 * The relation fields a model declares: every field pointing at another model, and none of its
 * scalars, not even the raw foreign key column backing one.
 *
 * @example
 * ```ts
 * type Relations = RelationKey<PrismaClient, "post">; // "author" | "editor" | "comments"
 * ```
 */
export type RelationKey<C, M extends ModelName<C>> = keyof Objects<C, M> & string;

/**
 * The model a relation field points at, whether that field holds one record or many.
 *
 * @example
 * ```ts
 * type Author = TargetModel<PrismaClient, "post", "author">; // "user"
 * ```
 */
export type TargetModel<C, M extends ModelName<C>, K extends RelationKey<C, M>> = {
  [P in ModelName<C>]: NonNullable<Unwrap<Objects<C, M>[K]>> extends { name: ModelTag<C, P> } ? P : never;
}[ModelName<C>];

type IsList<C, M extends ModelName<C>, K extends RelationKey<C, M>> = Objects<C, M>[K] extends readonly unknown[]
  ? true
  : false;

/**
 * The relation fields of `MC` that point at `MP`, read at one arity: the belongs-to side by default,
 * the fields holding many records when `List` is `true`.
 *
 * @example
 * ```ts
 * type ToUser = RelationsTo<PrismaClient, "post", "user">; // "author" | "editor"
 * ```
 */
export type RelationsTo<C, MC extends ModelName<C>, MP extends ModelName<C>, List extends boolean = false> = {
  [K in RelationKey<C, MC>]: TargetModel<C, MC, K> extends MP ? (IsList<C, MC, K> extends List ? K : never) : never;
}[RelationKey<C, MC>];

type UnionToIntersection<U> = (U extends unknown ? (union: U) => void : never) extends (i: infer I) => void ? I : never;

type IsUnion<U> = [U] extends [UnionToIntersection<U>] ? false : true;

type Side<List extends boolean> = List extends true ? "has-many" : "belongs-to";

/**
 * How a relation is selected between a child model and a parent model, at one arity: the relation
 * field may be left out where the pair shares exactly one, must be named where it shares several,
 * and no value satisfies the parameter where it shares none.
 *
 * `List` reads the same side {@link RelationsTo} reads: the belongs-to side by default, the fields
 * holding many records when `true`.
 *
 * @example
 * ```ts
 * type Args = RelationArgs<PrismaClient, "post", "user">; // [relationField: "author" | "editor"]
 * ```
 */
export type RelationArgs<C, MC extends ModelName<C>, MP extends ModelName<C>, List extends boolean = false> =
  // Ordered: `IsUnion<never>` is `false`, so a pair sharing no relation at this arity reaches the
  // optional branch and satisfies every call unless this branch catches it first.
  [RelationsTo<C, MC, MP, List>] extends [never]
    ? [relationField: `ERROR: no ${Side<List>} relation from "${MC & string}" to "${MP & string}"`]
    : IsUnion<RelationsTo<C, MC, MP, List>> extends true
      ? [relationField: RelationsTo<C, MC, MP, List>]
      : [relationField?: RelationsTo<C, MC, MP, List>];

/**
 * What stands for one record of a model: a factory of it, or a row of it.
 *
 * The row the factory returns is pinned to one record, which is what keeps a batched factory — whose
 * `create` returns a row each — from standing here. Its state map stays `unknown`: that one sits in
 * output positions only, so a factory carrying any states satisfies this.
 *
 * @example
 * ```ts
 * const author: Parent<PrismaClient, "user"> = userFactory;
 * ```
 */
export type Parent<C, P> = P extends ModelName<C> ? Factory<C, P, Row<C, P>, unknown> | Row<C, P> : never;

/**
 * What stands for one record of any model the client carries.
 *
 * @example
 * ```ts
 * declare function connect<T extends ParentValue<PrismaClient>>(parent: T): void;
 * ```
 */
export type ParentValue<C> = Parent<C, ModelName<C>>;

/**
 * The model a parent value belongs to, recovered from the value's own type.
 *
 * A row is `Types.Public.Result<C[P], …>`, an indexed access no inference can invert, so the model is
 * found by asking which one the value is a parent of rather than by inferring it from the value's
 * shape. A model whose scalars are a subset of another's answers both, so the pair is ambiguous and
 * the relation field has to be named.
 *
 * @example
 * ```ts
 * type Model = ParentModel<PrismaClient, Row<PrismaClient, "user">>; // "user"
 * ```
 */
export type ParentModel<C, T> = { [P in ModelName<C>]: [T] extends [Parent<C, P>] ? P : never }[ModelName<C>];

/**
 * What stands for the records a model holds many of: a factory of it, batched or not, a row of it, or
 * an array of rows.
 *
 * The row the factory returns is read at either arity, which is the whole of what separates this from
 * {@link Parent}: a batched factory creates a record per parent record here, and stands for no one
 * record there.
 *
 * @example
 * ```ts
 * const written: Child<PrismaClient, "post"> = postFactory.count(3);
 * ```
 */
export type Child<C, P> =
  P extends ModelName<C> ? Factory<C, P, Row<C, P> | Row<C, P>[], unknown> | Row<C, P> | readonly Row<C, P>[] : never;

/**
 * What stands for the records of any model the client carries.
 *
 * @example
 * ```ts
 * declare function attach<T extends ChildValue<PrismaClient>>(children: T): void;
 * ```
 */
export type ChildValue<C> = Child<C, ModelName<C>>;

/**
 * The model a child value belongs to, recovered from the value's own type the way {@link ParentModel}
 * recovers a parent's, and ambiguous under the same shapes.
 *
 * @example
 * ```ts
 * type Model = ChildModel<PrismaClient, Row<PrismaClient, "post">[]>; // "post"
 * ```
 */
export type ChildModel<C, T> = { [P in ModelName<C>]: [T] extends [Child<C, P>] ? P : never }[ModelName<C>];

// A relation field the pair leaves optional is skippable, so the options object stands alone as well;
// where the field has to be named — or where no field satisfies the parameter at all — it does not.
// Appending the options to the spread alone would bar the options-only call, which the tuple reaches
// by position and never by shape.
type WithOptions<A extends unknown[], Options> = [] extends A
  ? [...A, options?: Options] | [options: Options]
  : [...A, options?: Options];

/**
 * How the has-many relation from `M` to `MC` is selected, and the options object trailing it.
 *
 * The field selected is the one `M` declares, so the pair is read in the order {@link RelationArgs}
 * reads it — the model holding the field first — at the arity holding many records.
 *
 * @example
 * ```ts
 * type Args = HasManyArgs<PrismaClient, "user", "post", { inverse?: string }>;
 * // [relationField: "posts" | "edited", options?: { inverse?: string }]
 * ```
 */
export type HasManyArgs<C, M extends ModelName<C>, MC extends ModelName<C>, Options> = WithOptions<
  RelationArgs<C, M, MC, true>,
  Options
>;

// A relation field whose arity is not the one asked for keeps Prisma's own input.
type RelationValue<C, M extends ModelName<C>, K, List extends boolean = false> =
  K extends RelationKey<C, M> ? (IsList<C, M, K> extends List ? Parent<C, TargetModel<C, M, K>> : never) : never;

// Distributed over the mutually exclusive branches Prisma's create input holds, each of which pads
// the keys the other owns with `?: never`: a padded key is left alone, so naming a raw foreign key
// and its relation field at once stays an error.
type WidenRelations<T, C, M extends ModelName<C>> = T extends object
  ? { [K in keyof T]: [Exclude<T[K], undefined>] extends [never] ? T[K] : T[K] | RelationValue<C, M, K> }
  : T;

/**
 * The `data` a model's `create` accepts, nested relation input included, with every relation field
 * holding one record also taking a factory of the model it points at, or a row of that model.
 *
 * @example
 * ```ts
 * const data: CreateInput<PrismaClient, "post"> = { title: "Hello", author: userFactory };
 * ```
 */
export type CreateInput<C, M extends ModelName<C>> = WidenRelations<Types.Public.Args<C[M], "create">["data"], C, M>;

// TypeScript drops excess property checking when an object literal reaches its target through a
// function's contextual return type, which is where every definition sits, so plain assignability
// accepts a field the model never declares.
type Exact<T, U> = { [K in keyof T]: K extends keyof U ? T[K] : never } & U;

/**
 * What a definition may return: the model's create input, and nothing beyond it.
 *
 * `D` is the type of the object the definition actually returns, which the compiler infers.
 *
 * @example
 * ```ts
 * const definition = ({ uid }: EvaluationContext): Attributes<PrismaClient, "user", { email: string }> => ({
 *   email: `${uid}@example.com`,
 * });
 * ```
 */
export type Attributes<C, M extends ModelName<C>, D> = Exact<D, CreateInput<C, M>>;

type Skippable<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Any subset of the model's create input: every key optional, and free to carry an explicit
 * `undefined`, which every layer of a merge skips.
 *
 * @example
 * ```ts
 * const attributes: PartialAttributes<PrismaClient, "user"> = { name: "Ada" };
 * ```
 */
export type PartialAttributes<C, M extends ModelName<C>> = Skippable<CreateInput<C, M>>;

/**
 * What `create` accepts: any subset of the model's create input, and nothing beyond it.
 *
 * `O` is the type of the object actually passed, which the compiler infers. A key may carry an
 * explicit `undefined`, which `create` skips.
 *
 * @example
 * ```ts
 * const overrides: Overrides<PrismaClient, "user", { name: string }> = { name: "Ada" };
 * ```
 */
export type Overrides<C, M extends ModelName<C>, O> = Exact<O, PartialAttributes<C, M>>;
