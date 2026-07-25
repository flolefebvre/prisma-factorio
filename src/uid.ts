/**
 * Issues one uid per call.
 *
 * @example
 * ```ts
 * const email = `user-${nextUid()}@example.com`;
 * ```
 */
export type UidSource = () => string;

const PREFIX_LENGTH = 6;
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Draws a random prefix for a uid source.
 *
 * @example
 * ```ts
 * randomUidPrefix(); // "k3f8p1"
 * ```
 */
export function randomUidPrefix(): string {
  const bytes = new Uint8Array(PREFIX_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => DIGITS.charAt(byte % DIGITS.length)).join("");
}

/**
 * Builds a uid source: a prefix followed by a counter that climbs by one per call.
 *
 * Uids stay unique beyond the source that issued them only because the prefix differs, so pass one
 * explicitly only to make a test deterministic.
 *
 * @example
 * ```ts
 * const nextTestUid = createUidSource("aaaaaa");
 * nextTestUid(); // "aaaaaa0"
 * nextTestUid(); // "aaaaaa1"
 * ```
 */
export function createUidSource(prefix: string = randomUidPrefix()): UidSource {
  let counter = 0;

  return () => {
    const uid = `${prefix}${counter.toString(36)}`;
    counter += 1;
    return uid;
  };
}

/**
 * The uid source every record evaluation draws from.
 *
 * Its prefix is drawn once per process, so records built by test workers running side by side
 * against one database never claim the same uid — a counter alone restarts in every worker.
 *
 * @example
 * ```ts
 * const context = { faker, index: 0, uid: nextUid() };
 * ```
 */
export const nextUid: UidSource = createUidSource();
