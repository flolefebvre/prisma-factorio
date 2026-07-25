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

- A state is either a plain partial of the model's attributes or a closure returning one. A closure receives everything a definition gets, plus `attrs` — the attributes evaluated so far, the definition first and then the states already applied — and `parent`, which stays `undefined` until `has` populates it ([#30](https://github.com/flolefebvre/prisma-factorio/issues/30)).
- **Every `states` key becomes a typed method.** `users.suspended()` autocompletes and `users.suspnded()` is a compile error, as is a state naming a field the model does not have or giving one the wrong type. This is the compile-checked replacement for Laravel's magic state methods.
- `.state(partialOrClosure)` applies a one-off transformation at the call site, typed exactly like a declared state.
- **Order of application:** the definition, then the states in the order they were applied, then `create(overrides)`. Last write wins per key; a key valued `undefined` is skipped at every layer, so the layer before it stands; a `null` is written.
- States evaluate once per record, so a closure in a `count(3)` chain sees each record's own `index` and `uid`.
- A state may not be named `create`, `count`, `using`, `state`, `for` or `then` — the first five are methods the factory already answers to, and a factory carrying a `then` would be thenable and never settle when awaited. Either way the collision is a compile error and a `TypeError` at `define`.
- Declare states in the object you pass to `define`. Annotating that object with `FactoryConfig<Client, "model">` leaves the state names unknown to the compiler, which is why a config typed that way accepts no `states` at all.

### Relations

`for()` attaches every record a factory creates to one parent — a factory of the parent model, or a row of it:

```ts
const post = await posts.for(users, "author").create();

const ada = await users.create({ name: "Ada Lovelace" });
const byAda = await posts.for(ada, "author").create();
```

- **The relation field is checked against the pair of models.** It may be left out where the two share exactly one belongs-to relation, must be named where they share several, and no value satisfies it where they share none — a `for()` between two unrelated models is a compile error.
- **To-one relations only.** A relation field holding many records is a compile error; that side arrives with `has`.
- **`for()` returns a new factory, and states survive it in both chaining directions.** `posts.for(users, "author").drafted()` and `posts.drafted().for(users, "author")` both apply the state.

A relation field also takes a parent directly — in a definition, in a state, or in `create()` overrides:

```ts
export const guests = f.define("user", {
  definition: ({ uid }) => ({ email: `guest-${uid}@example.com` }),
});

export const posts = f.define("post", {
  definition: ({ faker, index }) => ({ title: `${faker.lorem.words(3)} #${String(index)}`, author: users }),
  states: { byGuest: { author: guests }, drafted: { title: "draft" } },
});

await posts.create({ author: ada });
```

Such a value is a factory, an existing row, or Prisma's own relation input — `{ connect: … }` and `{ create: … }` reach the client untouched.

**Ordering.** `for()` is a chain layer at the position it was called: an inline state that sets the relation field. So a relation default embedded in the definition loses to every layer above it, `for()` and states resolve against each other **by call order**, and the overrides `create()` was given beat both.

```ts
await posts.byGuest().for(users, "author").create(); // for() called last — the user factory wins
await posts.for(users, "author").byGuest().create(); // the state called last — byGuest wins
```

**This is a deliberate deviation from Laravel**, where a state always beats `for()`. Here the call order decides, which is the rule every other layer of the chain already follows.

**Batch cadence.** `.for(x)` names one specific parent, so a whole batch connects to it. A relation default in a definition describes each record independently, so a batch draws one parent each:

```ts
await posts.count(3).for(users, "author").create(); // 3 posts, 1 user
await posts.count(3).create(); // 3 posts, 3 users — the definition's own `author: users`
```

A shared parent lasts exactly one `create()` call: calling `create()` twice draws two parents.

**No orphans.** A parent whose relation key a later layer overwrites is never created at all — the losing factory is never evaluated.

## Good to know

- **Every fluent call returns a new factory.** `users.count(3)` does not change `users`.
- **No implicit transaction.** Records are written one `create` call at a time, sequentially — never `createMany`. Atomicity is the caller's job: pass a transaction client with `.using(tx)`. This is a deliberate decision ([ADR 0002](docs/adr/0002-relation-wiring.md)), not an oversight.
- **Attributes are typed, but the merge is not.** States and overrides replace values key by key, last write wins. An override whose value is `undefined` is skipped, so the definition's value stands — `create({ name: cond ? "Ada" : undefined })` falls back to the definition rather than blanking the column. Prisma's mutually exclusive create-input branches are only checked within a single object, so a definition using `author: { create: … }` combined with overrides passing `authorId` type-checks and then fails at runtime with `Unknown argument 'authorId'`.
- **Error shape.** A misspelled field reports `Type 'string' is not assignable to type 'never'` on the offending property — the same shape Prisma's own errors take.
- **Faker's typing has one edge.** `faker` in the evaluation context is typed by a direct `import type` from `@faker-js/faker`. Without the package installed and with `skipLibCheck: false`, you get one `TS2307` from this package's type declarations; with `skipLibCheck: true` (which `tsc --init` leaves active) it compiles cleanly and the `faker` type degrades. Definitions that never mention `faker` run fine without the package; reading anything off `faker` without it throws an error naming what to install.
- **No `make()` or `raw()`.** `create()` is the single verb — a factory always writes to the database. This is a deliberate deviation from Laravel.
- **An explicit `id` and a relation field cannot meet.** Prisma's _checked_ create input carries no `id`, so naming one forces the record into the _unchecked_ branch, which drops the relation field and demands the raw foreign key column instead — the one thing [ADR 0002](docs/adr/0002-relation-wiring.md) forbids this library writing. `posts.create({ id: 7 })` and `posts.create({ id: 7, authorId: 1 })` compile; `posts.create({ id: 7, author: { connect: { id: 1 } } })` is a compile error; and an `id` arriving through overrides while the relation comes from the definition type-checks, then fails at runtime with a Prisma validation error naming `id`. There is no workaround — this is Prisma's input shape meeting ADR 0002, not a gap here.
- **Connecting an existing row matches on the whole row.** A row parent is splatted into the `connect` where-clause, because the runtime datamodel marks no field unique and no subset of a row is knowably the one Prisma would match on. Every field therefore narrows the match, so a row read _before_ the record changed fails loudly with Prisma's `P2025` rather than silently connecting to whatever the record has since become.
- **`.using(client)` covers the whole graph.** It redirects not just this factory's records but every parent factory its creates resolve, however deep the chain of relation defaults goes — so one `.using(tx)` puts a whole factory graph in a single interactive transaction, and a rollback leaves nothing behind. A parent factory that named a client of its own keeps it, and its own parents then run on that one. The library still opens no transaction itself, exactly as [ADR 0002](docs/adr/0002-relation-wiring.md) says.
- **`CreateInput` is no longer a Prisma alias.** This package exports it, and this release changed what it means: a relation key now additionally accepts a `Factory` or a row, so a value typed `CreateInput<Client, "model">` is no longer assignable to Prisma's own `create` `data` argument. If you imported it as a stand-in for Prisma's input type, it has stopped being one.

## Status

v1 is in progress; this README tracks what actually works today.

Available now: bootstrap from a client or a thunk with `seed` and `locale`, `define`, `create` with overrides, `count`, `using`, named states with inline `.state()`, the `{ faker, index, uid }` evaluation context, and `for` with relation defaults.

Tracked next, in no promised order: `has` relations, many-to-many, `recycle`, and `afterCreating`.
