# prisma-factorio

Laravel-style model factories for Prisma: tests and seeds declare the records they need through a fluent, fully typed API inferred from the user's generated Prisma client.

No generator, no build step, no schema parsing — the factory API reads model names, create inputs and row types straight off the client you already generate.

## Install

```bash
pnpm add -D prisma-factorio
```

Peer dependencies: `prisma` and `@prisma/client`, both `>=7 <8`. `@faker-js/faker` (`>=10 <11`) is an **optional** peer: install it only if your definitions read `faker`.

## Usage

Bootstrap once against your client, then define a factory per model:

```ts
// factories.ts
import { initPrismaFactorio } from "prisma-factorio";
import { prisma } from "./db.js"; // your own PrismaClient instance

const f = initPrismaFactorio(() => prisma, { seed: 1234, locale: "en" });

export const users = f.define("user", {
  definition: ({ faker, uid }) => ({
    email: `user-${uid}@example.com`,
    name: faker.person.fullName(),
  }),
});

export const posts = f.define("post", {
  definition: ({ faker, index, uid }) => ({
    title: `${faker.lorem.words(3)} #${String(index)}`,
    author: { create: { email: `author-${uid}@example.com` } },
  }),
});
```

Then create records:

```ts
import { prisma } from "./db.js";
import { posts, users } from "./factories.js";

const ada = await users.create({ name: "Ada Lovelace" });
// { id: 1, email: 'user-osifui0@example.com', name: 'Ada Lovelace' }

const team = await users.count(3).create();
// three rows, evaluated with index 0, 1 and 2

const written = await prisma.$transaction((tx) => posts.using(tx).count(2).create());
```

- The model name is the property the client carries — `"user"`, `"post"` — and the definition is checked against that model's create input, nested relation input included.
- `create()` returns the real row, or an array of rows when the factory carries a `count`.
- `initPrismaFactorio` takes a client instance or a thunk. **Prefer the thunk**: it is called on the first `create()` and never again, so importing a module full of factories constructs nothing.
- prisma-factorio never builds a client; you pass your own (a Prisma 7 client is constructed with a driver adapter).
- `seed` pins the values faker generates, so the same seed replays the same faker output; `locale` is any locale name `@faker-js/faker` exports.
- **A seed does not make a run reproducible.** Only faker's output replays. `uid` draws a fresh random prefix in every process — that is what keeps parallel test workers off each other's unique columns — so every `uid`-derived column differs from run to run. Do not snapshot them.

### Evaluation context

A definition receives `{ faker, index, uid }`:

- `faker` — the one faker instance this bootstrap is configured for.
- `index` — 0-based position of the record within the current batch; it restarts at 0 for every batch.
- `uid` — a short string unique across records and parallel test workers, one per record. Use it for unique columns.

### States

A state is a named attribute transformation. Declare states in the config and each key becomes a method on the factory:

```ts
export const users = f.define("user", {
  definition: ({ faker, uid }) => ({
    email: `user-${uid}@example.com`,
    name: faker.person.fullName(),
  }),
  states: {
    suspended: { name: null },
    vip: ({ attrs, uid }) => ({ email: `vip-${uid}@example.com`, name: `${attrs.name ?? "anonymous"} (VIP)` }),
  },
});

const banned = await users.suspended().create();
const vips = await users.count(3).vip().create();
const once = await users.state({ name: "Ada Lovelace" }).create();
```

- A state is either a plain partial of the model's attributes or a closure returning one. A closure receives everything a definition gets, plus `attrs` — the attributes evaluated so far, the definition first and then the states already applied — and `parent`, which stays `undefined` until relation support lands.
- **Every `states` key becomes a typed method.** `users.suspended()` autocompletes and `users.suspnded()` is a compile error, as is a state naming a field the model does not have or giving one the wrong type. This is the compile-checked replacement for Laravel's magic state methods.
- `.state(partialOrClosure)` applies a one-off transformation at the call site, typed exactly like a declared state.
- **Order of application:** the definition, then the states in the order they were applied, then `create(overrides)`. Last write wins per key; a key valued `undefined` is skipped at every layer, so the layer before it stands; a `null` is written.
- States evaluate once per record, so a closure in a `count(3)` chain sees each record's own `index` and `uid`.
- A state may not be named `create`, `count`, `using`, `state` or `then` — the first four are methods the factory already answers to, and a factory carrying a `then` would be thenable and never settle when awaited. Either way the collision is a compile error and a `TypeError` at `define`.
- Declare states in the object you pass to `define`. Annotating that object with `FactoryConfig<Client, "model">` leaves the state names unknown to the compiler, which is why a config typed that way accepts no `states` at all.

## Good to know

- **Every fluent call returns a new factory.** `users.count(3)` does not change `users`.
- **No implicit transaction.** Records are written one `create` call at a time, sequentially — never `createMany`. Atomicity is the caller's job: pass a transaction client with `.using(tx)`. This is a deliberate decision ([ADR 0002](docs/adr/0002-relation-wiring.md)), not an oversight.
- **Attributes are typed, but the merge is not.** States and overrides replace values key by key, last write wins. An override whose value is `undefined` is skipped, so the definition's value stands — `create({ name: cond ? "Ada" : undefined })` falls back to the definition rather than blanking the column. Prisma's mutually exclusive create-input branches are only checked within a single object, so a definition using `author: { create: … }` combined with overrides passing `authorId` type-checks and then fails at runtime with `Unknown argument 'authorId'`.
- **Error shape.** A misspelled field reports `Type 'string' is not assignable to type 'never'` on the offending property — the same shape Prisma's own errors take.
- **Faker's typing has one edge.** `faker` in the evaluation context is typed by a direct `import type` from `@faker-js/faker`. Without the package installed and with `skipLibCheck: false`, you get one `TS2307` from this package's type declarations; with `skipLibCheck: true` (which `tsc --init` leaves active) it compiles cleanly and the `faker` type degrades. Definitions that never mention `faker` run fine without the package; reading anything off `faker` without it throws an error naming what to install.
- **No `make()` or `raw()`.** `create()` is the single verb — a factory always writes to the database. This is a deliberate deviation from Laravel.

## Status

v1 is in progress; this README tracks what actually works today.

Available now: bootstrap from a client or a thunk with `seed` and `locale`, `define`, `create` with overrides, `count`, `using`, named states with inline `.state()`, and the `{ faker, index, uid }` evaluation context.

Tracked next, in no promised order: `has` / `for` relations, many-to-many, `recycle`, and `afterCreating`.
