/**
 * A client that reads as `client` in every respect but the schema text it carries, which is
 * `inlineSchema` — or none at all where that is `undefined`. The client's own prototype chain stays
 * intact, so a generated client keeps every delegate and method it answers.
 *
 * @example
 * ```ts
 * const schemaless = withInlineSchema(prisma, undefined);
 * ```
 */
export function withInlineSchema<T>(client: T, inlineSchema: string | undefined): T {
  const engineConfig = inlineSchema === undefined ? {} : { inlineSchema };

  return Object.create(client as object, { _engineConfig: { value: engineConfig } }) as T;
}
