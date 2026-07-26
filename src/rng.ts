/**
 * Picks one element of a list per call, and nothing at all from a list holding none.
 *
 * Picks are drawn in graph-traversal order — the order the records of a create reach the pool — and
 * a picker built on a fixed seed replays that whole order, pick for pick.
 *
 * @example
 * ```ts
 * const author = pick(pooledUsers);
 * ```
 */
export type Picker = <T>(list: readonly T[]) => T | undefined;

const RANGE = 0x1_0000_0000;

/**
 * Draws a seed for a picker left to seed itself.
 *
 * @example
 * ```ts
 * randomSeed(); // 2463534242
 * ```
 */
export function randomSeed(): number {
  const [seed = 0] = crypto.getRandomValues(new Uint32Array(1));
  return seed;
}

// mulberry32: one 32-bit word of state, advanced by a fixed odd stride and mixed down to a fraction.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / RANGE;
  };
}

/**
 * Builds a picker over a stream of its own, seeded explicitly to make a run replayable and drawn at
 * random otherwise.
 *
 * A list of one — and a list of none — is answered without drawing, so the stream a picker hands out
 * runs the same however long the lists picked from along the way turn out to be.
 *
 * @example
 * ```ts
 * const pick = createPicker(1234);
 * pick(["ada", "grace", "alan"]); // "grace"
 * ```
 */
export function createPicker(seed: number = randomSeed()): Picker {
  const random = mulberry32(seed);

  // A list with nothing to choose between has its answer already, and taking it without drawing is
  // what keeps the stream aligned across pools of differing size.
  return <T>(list: readonly T[]): T | undefined =>
    list.length < 2 ? list[0] : list[Math.floor(random() * list.length)];
}
