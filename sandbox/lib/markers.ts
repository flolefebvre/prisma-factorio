/** Runtime markers for definition values that are not plain data. */

export const FACTORY = Symbol.for("prisma-factorio.factory");
export const REF = Symbol.for("prisma-factorio.ref");
export const LAZY = Symbol.for("prisma-factorio.lazy");
export const CYCLE = Symbol.for("prisma-factorio.cycle");

/** What a deferred field value is given when the record is resolved. */
export interface FieldContext {
  /** Monotonic counter, unique per scope. Reset with `resetSequence()`. */
  readonly seq: number;
  /** Position of this record inside the current `count()` batch. */
  readonly index: number;
  /** Values resolved so far, in definition order. */
  readonly attrs: Record<string, unknown>;
}

export interface LazyMarker {
  [LAZY]: (context: FieldContext) => unknown;
}
export interface CycleMarker {
  [CYCLE]: readonly unknown[];
}
export interface RefMarker {
  [REF]: string;
}

export const isMarked = <K extends symbol>(value: unknown, key: K): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && key in value;

/**
 * Defers a field until the record is resolved, so it can depend on the
 * sequence counter, the batch position, or the fields resolved before it.
 * The declared type is the field's own, keeping the definition checked.
 *
 * @example
 * ```ts
 * define("user", {
 *   fields: {
 *     name: lazy(({ seq }) => `User ${seq}`),
 *     email: lazy(({ attrs }) => `${String(attrs["name"])}@example.com`),
 *   },
 * });
 * ```
 */
export const lazy = <T>(resolve: (context: FieldContext) => T): T => ({ [LAZY]: resolve }) as LazyMarker as T;

/**
 * Cycles a field through the given values, one per record in the batch.
 *
 * @example
 * ```ts
 * define("user", { fields: { role: cycle("admin", "member") } });
 * ```
 */
export const cycle = <T>(...values: readonly T[]): T => ({ [CYCLE]: values }) as CycleMarker as T;
