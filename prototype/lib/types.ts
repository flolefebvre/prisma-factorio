/** Delegate keys of a Prisma client (`"user" | "post" | ...`), derived from the client type alone. */
export type ModelKey<C> = {
  [K in keyof C]: C[K] extends { create: (...args: never[]) => unknown } ? K : never;
}[keyof C] &
  string;

/** The `data` payload accepted by `client[K].create()` — i.e. Prisma's `XCreateInput`. */
export type CreateInput<C, K extends keyof C> = C[K] extends {
  create: (args: infer A) => unknown;
}
  ? A extends { data: infer D }
    ? D
    : never
  : never;

/** The row returned by `client[K].create()` — Prisma's default model selection. */
export type Model<C, K extends keyof C> = C[K] extends {
  create: (...args: never[]) => infer R;
}
  ? Awaited<R>
  : never;

/** Unique selector accepted by `client[K].findUnique()` — Prisma's `XWhereUniqueInput`. */
export type WhereUnique<C, K extends keyof C> = C[K] extends {
  findUnique: (args: infer A) => unknown;
}
  ? A extends { where: infer W }
    ? W
    : never
  : never;

/** Relation fields of a create input: those whose value accepts a nested `create`. */
export type RelationKey<C, K extends keyof C> = {
  [F in keyof CreateInput<C, K>]-?: NonNullable<CreateInput<C, K>[F]> extends {
    create?: unknown;
  }
    ? F
    : never;
}[keyof CreateInput<C, K>] &
  string;

export interface ResolveContext {
  /** 0-based position within the current `count()` batch. */
  readonly index: number;
  /** Monotonic counter, unique per factory across the whole process. */
  readonly seq: number;
}

/** A definition value: a literal, a lazy function, or a nested factory. */
export type Resolvable<T> = T | ((attrs: Record<string, unknown>, ctx: ResolveContext) => T);
