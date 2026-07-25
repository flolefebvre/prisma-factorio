/**
 * The TypeScript behaviours the API shape had to be built around. `tsc` is the
 * assertion: every `@ts-expect-error` below must fire, and every line without
 * one must compile. Change the API and re-run this file to see what breaks.
 */
import type { DefinitionData } from "../lib/factory.ts";
import type { ModelName } from "../lib/types.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

declare const prisma: PrismaClient;

/* ---------------------------------------------------------------- *
 * 1. Excess property checking reaches object literals in value and
 *    argument position, but never a literal returned from a callback.
 * ---------------------------------------------------------------- */

interface Row {
  a?: string;
}
declare function takesValue(row: Row): void;
declare function takesCallback(build: () => Row): void;

// @ts-expect-error value position is checked
const value: Row = { a: "x", b: "y" };
void value;

// @ts-expect-error argument position is checked
takesValue({ a: "x", b: "y" });

// A callback's return is *not* checked, with or without a block body.
takesCallback(() => ({ a: "x", b: "y" }));
takesCallback(() => {
  return { a: "x", b: "y" };
});

// An explicit return type annotation restores the check.
// @ts-expect-error annotated return is checked
takesCallback((): Row => ({ a: "x", b: "y" }));

/* ---------------------------------------------------------------- *
 * 2. A definitions object whose type is inferred loses the check,
 *    because the inferred type is built from the literal itself.
 * ---------------------------------------------------------------- */

declare function inferred<C extends object, D>(
  client: C,
  defs: D & { [K in keyof D]: K extends ModelName<C> ? { fields: DefinitionData<C, K> } : never },
): D;

// No error: `nickname` became part of the inferred `D`.
inferred(prisma, { user: { fields: { name: "a", nickname: "c" } } });

/* ---------------------------------------------------------------- *
 * 3. Naming the model in argument position fixes it: `M` is resolved
 *    before the definition is checked, so the literal is checked
 *    against a concrete type. This is why `define("user", { … })` is
 *    the shape of the API.
 * ---------------------------------------------------------------- */

declare function named<C extends object>(
  client: C,
): <M extends ModelName<C>, S extends Record<string, DefinitionData<C, M>>>(
  model: M,
  definition: { fields: DefinitionData<C, M>; states?: S },
) => { model: M; states: S };

const define = named(prisma);

define("user", {
  // @ts-expect-error `nickname` is not a column on User
  fields: { name: "a", nickname: "c" },
});

// @ts-expect-error `name` is a string column
define("user", { fields: { name: 42 } });

// @ts-expect-error `orders` is not a model on this client
define("orders", { fields: {} });

// State names still survive inference, so they can become methods.
const user = define("user", {
  fields: { name: "a" },
  states: { admin: { role: "admin" }, banned: { role: "banned" } },
});
type StateNames = keyof (typeof user)["states"];
const names: StateNames[] = ["admin", "banned"];
void names;

/* ---------------------------------------------------------------- *
 * 4. `Prisma.Args<Delegate, "create">` cannot be indexed while the
 *    delegate is still generic; the result has to be inferred out.
 * ---------------------------------------------------------------- */

// See `lib/types.ts`: `CreateData` uses `extends { data: infer D }` for this
// reason. Indexing with `["data"]` fails with TS2536 under a type parameter.
type UserData = DefinitionData<PrismaClient, "user">;
const ok: UserData = { name: "a", email: "b" };
void ok;
