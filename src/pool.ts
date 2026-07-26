/**
 * The rows a factory chain recycles, kept in a list per model.
 *
 * A model the pool names carries at least one row: a model pooled with none is absent, which is what
 * tells a pool nothing can be drawn from apart from one that was never asked for.
 *
 * @example
 * ```ts
 * const pool: Pool = { user: [ada, grace] };
 * ```
 */
export type Pool = Readonly<Record<string, readonly unknown[]>>;

/**
 * Adds rows to a model's list, handing back a pool of its own and leaving the one it was given as it
 * stands.
 *
 * Rows accumulate rather than replace, so a factory configured with a pool and extended at a call
 * site keeps its baseline rows; pooling no rows leaves the model exactly as it was.
 *
 * @example
 * ```ts
 * const pool = recycledPool(recycledPool({}, "user", ada), "user", [grace, alan]);
 * // { user: [ada, grace, alan] }
 * ```
 */
export function recycledPool(pool: Pool, model: string, rows: unknown): Pool {
  const added = Array.isArray(rows) ? (rows as unknown[]) : [rows];
  const merged = [...(pool[model] ?? []), ...added];

  return merged.length === 0 ? pool : { ...pool, [model]: merged };
}
