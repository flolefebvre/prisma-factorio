import type { Types } from "@prisma/client/runtime/client";

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
 * The `data` a model's `create` accepts, nested relation input included.
 *
 * @example
 * ```ts
 * const data: CreateInput<PrismaClient, "user"> = { email: "ada@example.com" };
 * ```
 */
export type CreateInput<C, M extends ModelName<C>> = Types.Public.Args<C[M], "create">["data"];

/**
 * The row a model's `create` returns: every scalar the model holds, none of its relations.
 *
 * @example
 * ```ts
 * const row: Row<PrismaClient, "user"> = { id: 1, email: "ada@example.com", name: null };
 * ```
 */
export type Row<C, M extends ModelName<C>> = Types.Public.Result<C[M], object, "create">;

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

/**
 * What `create` accepts: any subset of the model's create input, and nothing beyond it.
 *
 * `O` is the type of the object actually passed, which the compiler infers.
 *
 * @example
 * ```ts
 * const overrides: Overrides<PrismaClient, "user", { name: string }> = { name: "Ada" };
 * ```
 */
export type Overrides<C, M extends ModelName<C>, O> = Exact<O, Partial<CreateInput<C, M>>>;
