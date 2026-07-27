# prisma-factorio

Laravel-style model factories for [Prisma](https://www.prisma.io): tests and seeds declare the records they need through a fluent, fully typed API — inferred entirely from the Prisma client you already generate.

[![npm](https://img.shields.io/npm/v/@flefebvre/prisma-factorio.svg)](https://www.npmjs.com/package/@flefebvre/prisma-factorio)
[![CI](https://github.com/flolefebvre/prisma-factorio/actions/workflows/ci.yml/badge.svg)](https://github.com/flolefebvre/prisma-factorio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/flolefebvre/prisma-factorio/blob/main/LICENSE)

```ts
const ada = await userFactory.create({ name: "Ada Lovelace" });

const team = await userFactory.count(3).vip().create();

const author = await userFactory.has(postFactory.count(2), "posts").create();
```

No generator, no build step, no schema parsing: the factory API reads model names, create inputs and row types straight off your generated client. A misspelled field, a state that does not exist, a `for()` between unrelated models — each one is a compile error, not a runtime surprise.

## Why factories?

Setting up test data with a bare Prisma client means hand-writing every required column of every record — and of every record it relates to. That boilerplate gets copied between tests, drifts, and buries the one field the test actually cares about.

A factory moves the boilerplate into a single definition per model, so a test states only what matters:

```ts
const post = await postFactory.create({ title: "Typed all the way down" });
```

Everything else — the author the post needs, the unique email that author needs — comes from the definitions, freshly generated per record.

The feature set is a port of [Laravel's model factories](https://laravel.com/docs/eloquent-factories) to Prisma's semantics. Where the two part company, it is deliberate — see [Deviations from Laravel](#deviations-from-laravel).

## Features

- **Fully typed, zero codegen** — definitions are checked against your model's create input, nested relations included; nothing is generated, so nothing drifts from your schema.
- **States as real methods** — every state you declare becomes a typed method on the factory: `userFactory.suspended()` autocompletes, `userFactory.suspnded()` is a compile error.
- **Relations** — attach a parent with `for()`, children with `has()`, or embed either directly in a definition; relation fields are validated against the model pair.
- **Many-to-many** — both shapes Prisma offers, with pivot columns as ordinary typed attributes.
- **Recycle pools** — hand over existing rows and the whole graph connects them instead of creating duplicates.
- **Batches** — `count(n)` evaluates the definition once per record, each with its own `index` and `uid`.
- **Callbacks** — `afterCreating` side effects, declared in the config or added on the chain.
- **Transaction-friendly** — `.using(tx)` routes an entire graph through your transaction; the library never opens one of its own.
- **Faker built in, but optional** — seeded and locale-aware when installed, not required otherwise.

## Table of contents

- [Installation](#installation)
- [Getting started](#getting-started)
- [States](#states)
- [Relations](#relations)
- [Children](#children)
- [Many-to-many](#many-to-many)
- [Recycle](#recycle)
- [Callbacks](#callbacks)
- [Seeding](#seeding)
- [Transactional tests](#transactional-tests)
- [Deviations from Laravel](#deviations-from-laravel)
- [Gotchas](#gotchas)
- [Status](#status)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
pnpm add -D @flefebvre/prisma-factorio
# or: npm install -D @flefebvre/prisma-factorio · yarn add -D @flefebvre/prisma-factorio
```

Requirements:

- **Node ≥ 20**, ESM only — there is no CommonJS `require` entry.
- **`@prisma/client` `>=7 <8`** — the only required peer. The only `prisma` import this package makes is type-only.
- **Optional peers**: the `prisma` CLI (`>=7 <8`) — yours already if you run migrations or generation — and `@faker-js/faker` (`>=10 <11`), needed only by definitions that actually read `faker`.

## Getting started

Bootstrap once against your client, then define a factory per model:

```ts
// factories.ts
import { initPrismaFactorio } from "@flefebvre/prisma-factorio";
import { prisma } from "./db.js"; // your own PrismaClient instance

const prismaFactorio = initPrismaFactorio(() => prisma, { seed: 1234, locale: "en" });

export const userFactory = prismaFactorio.define("user", {
  definition: ({ faker, uid }) => ({
    email: `user-${uid}@example.com`,
    name: faker.person.fullName(),
  }),
});

export const postFactory = prismaFactorio.define("post", {
  definition: ({ faker, index, uid }) => ({
    title: `${faker.lorem.words(3)} #${String(index)}`,
    author: { create: { email: `author-${uid}@example.com` } },
  }),
});
```

Then create records:

```ts
import { prisma } from "./db.js";
import { postFactory, userFactory } from "./factories.js";

const ada = await userFactory.create({ name: "Ada Lovelace" });
// { id: 1, email: 'user-osifui0@example.com', name: 'Ada Lovelace' }

const team = await userFactory.count(3).create();
// three rows, evaluated with index 0, 1 and 2

const written = await prisma.$transaction((tx) => postFactory.using(tx).count(2).create());
```

How it fits together:

- The model name is the property your client carries — `"user"`, `"post"` — and the definition is checked against that model's create input, nested relation input included.
- `create()` persists through your client and returns the real database row, or an array of rows when the factory carries a `count()`.
- **Every fluent call returns a new factory.** `userFactory.count(3)` leaves `userFactory` untouched, so factories are safe to share and compose.
- `initPrismaFactorio` takes a client instance or a thunk. **Prefer the thunk**: it is called on the first `create()` and never again, so importing a module full of factories constructs nothing.
- prisma-factorio never builds a client; you pass your own. (A Prisma 7 client is constructed with a driver adapter.)
- `seed` pins the values faker generates and the rows a [recycle](#recycle) pool picks, so the same seed replays both; `locale` is any locale name `@faker-js/faker` exports.

> [!WARNING]
> **A seed does not make a run reproducible.** Only faker's output replays. `uid` draws a fresh random prefix in every process — that is what keeps parallel test workers off each other's unique columns — so every `uid`-derived column differs from run to run. Do not snapshot them.

### Evaluation context

A definition receives `{ faker, index, uid }`:

- `faker` — the one faker instance this bootstrap is configured for.
- `index` — the record's 0-based position within the current batch; it restarts at 0 for every batch.
- `uid` — a short string unique across records and parallel test workers, one per record. Use it for unique columns.

## States

A state is a named attribute transformation. Declare states in the config and each key becomes a method on the factory:

```ts
export const userFactory = prismaFactorio.define("user", {
  definition: ({ faker, uid }) => ({
    email: `user-${uid}@example.com`,
    name: faker.person.fullName(),
  }),
  states: {
    suspended: { name: null },
    vip: ({ attrs, uid }) => ({ email: `vip-${uid}@example.com`, name: `${attrs.name ?? "anonymous"} (VIP)` }),
  },
});

const banned = await userFactory.suspended().create();
const vips = await userFactory.count(3).vip().create();
const once = await userFactory.state({ name: "Ada Lovelace" }).create();
```

- A state is a plain partial of the model's attributes, or a closure returning one. The closure receives everything a definition gets, plus:
  - `attrs` — the attributes evaluated so far: the definition first, then the states already applied.
  - `parent` — the row this record is being created for, when a [`has()`](#children) layer or a many-holding relation field brought one; `undefined` otherwise.
- **Every `states` key becomes a typed method.** `userFactory.suspended()` autocompletes and `userFactory.suspnded()` is a compile error, as is a state naming a field the model does not have or giving one the wrong type. This is the compile-checked replacement for Laravel's magic state methods.
- `.state(partialOrClosure)` applies a one-off transformation at the call site, typed exactly like a declared state.
- **Layers apply in order**: the definition, then the states in the order they were applied, then `create(overrides)`. Last write wins per key — except the relation field a [`has()`](#children) layer adds to rather than replaces. A value of `undefined` is skipped at every layer, so the layer before it stands; a `null` is written.
- States evaluate once per record, so a closure under `count(3)` sees each record's own `index` and `uid`.
- A state may not be named `create`, `count`, `using`, `state`, `for`, `has`, `recycle`, `afterCreating` or `then` — the first eight are methods the factory already answers to, and a factory carrying a `then` would be thenable and never settle when awaited. The collision is a compile error and a `TypeError` at `define`.
- Declare states inline in the object you pass to `define`. Annotating that object as `FactoryConfig<Client, "model">` erases the state names for the compiler, which is why a config typed that way accepts no `states` at all.

## Relations

`for()` attaches every record a factory creates to one parent — a factory of the parent model, or an existing row of it:

```ts
const post = await postFactory.for(userFactory, "author").create();

const ada = await userFactory.create({ name: "Ada Lovelace" });
const byAda = await postFactory.for(ada, "author").create();
```

- **The relation field is checked against the pair of models.** Leave it out where the two share exactly one belongs-to relation; name it where they share several. Where they share none, no value satisfies it — a `for()` between unrelated models is a compile error.
- **A relation value matches the arity of the field it stands in.** A field holding a single record takes a value standing for one record. A field holding many takes a factory, a row or a list of rows, and treats what stands there as [children](#children) — in a definition, in a state and in `create()` overrides alike. That is `has()`'s own mechanism reached as a value rather than a method, and it sets the field where `has()` adds to it.
- **`for()` returns a new factory, and states survive it in both chaining directions.** `postFactory.for(userFactory, "author").drafted()` and `postFactory.drafted().for(userFactory, "author")` both apply the state.

A relation field also takes a parent directly — in a definition, in a state, or in `create()` overrides:

```ts
export const guestFactory = prismaFactorio.define("user", {
  definition: ({ uid }) => ({ email: `guest-${uid}@example.com` }),
});

export const postFactory = prismaFactorio.define("post", {
  definition: ({ faker, index }) => ({ title: `${faker.lorem.words(3)} #${String(index)}`, author: userFactory }),
  states: { byGuest: { author: guestFactory }, drafted: { title: "draft" } },
});

await postFactory.create({ author: ada });
```

Such a value is a factory, an existing row, or Prisma's own relation input — `{ connect: … }` and `{ create: … }` reach the client untouched. A field holding many records takes a batched factory and a list of rows besides.

**Ordering.** `for()` is a chain layer at the position it was called — in effect, an inline state that sets the relation field. So a relation default embedded in the definition loses to every layer above it, `for()` and states resolve against each other **by call order**, and the overrides `create()` was given beat both:

```ts
await postFactory.byGuest().for(userFactory, "author").create(); // for() called last — the user factory wins
await postFactory.for(userFactory, "author").byGuest().create(); // the state called last — byGuest wins
```

Call order is the one rule every layer of the chain follows. Laravel settles this collision the other way round — one of the [deviations from Laravel](#deviations-from-laravel).

**Batch cadence.** `.for(x)` names one specific parent, so a whole batch connects to it. A relation default in a definition describes each record independently, so a batch draws one parent each:

```ts
await postFactory.count(3).for(userFactory, "author").create(); // 3 posts, 1 user
await postFactory.count(3).create(); // 3 posts, 3 users — the definition's own `author: userFactory`
```

A shared parent lasts exactly one `create()` call: calling `create()` twice draws two parents.

**No orphans.** A parent whose relation key a later layer overwrites is never created at all — the losing factory is never evaluated.

**A field holding many records takes a value too**, and what stands there is children rather than a parent:

```ts
const author = await userFactory.create({ posts: postFactory.count(2) });
// one user, two posts, each reaching back to it

const draft = await postFactory.create();
const reposted = await userFactory.create({ posts: [draft] });
// the existing post attached to a second user, no post created
```

- **The children are created once the parent row exists**, one set per record of the batch, exactly as [`has()`](#children) creates them: each reads that row through `parent`, is written through the client the chain names, and fires its own callbacks ahead of the parent's.
- **The value sets the field, where `has()` adds to it.** A definition, a state or an override naming the field replaces what stands there whole — children a `has()` layer gathered included, and a factory so replaced is never evaluated — while a `has()` call made after it adds on top.
- **Values are created ahead of `has()` layers**: the relation fields first, in the order the merged attributes hold them, then the `has()` calls in the order they were made.
- **A batch of no children writes nothing.** `{ posts: [] }` and `{ posts: postFactory.count(0) }` leave the relation field unwritten, exactly as `has([])` does.

## Children

`has()` fills a relation field holding many records, alongside every record the factory creates. Give it a child factory — whose records are created for each parent record through that model's own `create` — or existing rows, which are connected as they stand and never re-created:

```ts
const author = await userFactory.has(postFactory.count(3), "posts").create();
```

`create()` returns the **user**; the three posts are created after it, each reaching back to that user, and are not returned.

- **The relation field is checked against the pair of models**, exactly as `for()` checks it: optional where the pair shares exactly one has-many relation, required where they share several, unsatisfiable where they share none.
- **A child reads the record it was created for.** `parent` in a child's state closure is the created parent row — real `id`, database defaults included. Its type spans every model the client carries, so narrow it before reading a field only some of them declare.
- **`has()` adds, every other layer replaces.** Two calls on one relation field both apply, and a `has()` after a state adds to what that state left standing. A state or a `create()` override naming that field replaces it whole — a child factory so replaced creates nothing.
- **Ordering is depth-first.** Every child of one record is created before the next record of a batch, layer by layer in the order the calls were made.
- **`has(factory.count(0))` and `has([])` are legal**, and create the parent with nothing attached.
- **`inverse` names the relation field the child reaches its parent back through** — `userFactory.has(postFactory, "posts", { inverse: "author" })` — for a relation whose two sides the client's metadata cannot pair down to one. It bypasses that lookup and nothing else.

**Narrowing `parent`.** Use `"field" in parent` — even for `id`, because a join model such as `Membership` may declare none, so no column is common to every model:

```ts
const creditedFactory = prismaFactorio.define("post", {
  definition: ({ uid }) => ({ title: uid, author: userFactory }),
  states: {
    credited: ({ parent }) => ({
      title: parent !== undefined && "id" in parent ? `by ${String(parent.id)}` : "unattributed",
    }),
  },
});

await userFactory.has(creditedFactory.credited(), "posts").create();
// one user, one post titled after that user's own id
```

The guard has two conditions because `parent` is `undefined` for a record no layer brought one for. There is deliberately no narrowing helper in the API ([#48](https://github.com/flolefebvre/prisma-factorio/issues/48)) — a closure reading several columns is worth lifting into a helper of your own.

**Batch cadence.** Children are created per parent record, where a `for()` parent is evaluated once per `create()` call:

```ts
await userFactory.count(3).has(postFactory.count(2), "posts").create(); // 3 users, 6 posts — 2 each
await postFactory.count(3).for(userFactory, "author").create(); // 3 posts, 1 user — shared
```

Same fluent shape, opposite multiplicity.

## Many-to-many

There is no `hasAttached()`. Both shapes Prisma offers are reached with what the chain already carries: `has()` for the implicit form, and composition through the join model's own factory for the explicit one.

**Implicit** — a list field on both sides, the join table hidden by Prisma:

```prisma
model Post {
  id    Int    @id @default(autoincrement())
  title String
  tags  Tag[]
}

model Tag {
  id    Int    @id @default(autoincrement())
  label String
  posts Post[]
}
```

```ts
const post = await postFactory.has(tagFactory.count(3)).create(); // three tags, all joined to the post
const tag = await tagFactory.has(postFactory.count(2)).create(); // the same, read from the other end
await postFactory.has(existingTags).create(); // rows attach as they stand, no tag created
```

- **`has()` reads a many-to-many from whichever end reads better.** The two sides are an ordinary relation pair here, and the hidden join table adds no model of its own.
- **`for()` is a compile error at both ends — correctly.** Both sides hold many records, so the pair has no belongs-to side for `for()` to name.
- **The cadence is the usual one.** `postFactory.count(3).has(tagFactory.count(2))` gives 3 posts and 6 tags, two each.
- **Pivot attributes are impossible on this shape** — Prisma's hidden join table carries no extra columns. Declare the relation explicitly when it has data of its own.

**Explicit** — a join model you declare, carrying its own columns:

```prisma
model Membership {
  user   User   @relation(fields: [userId], references: [id])
  userId Int
  team   Team   @relation(fields: [teamId], references: [id])
  teamId Int
  role   String

  @@id([userId, teamId])
}
```

`User` and `Team` share no relation field, only the hop through `Membership`, so the pattern is composition — the join model's factory stands between them:

```ts
const membershipFactory = prismaFactorio.define("membership", {
  definition: () => ({ role: "member", user: userFactory, team: teamFactory }),
});

const ada = await userFactory.has(membershipFactory.count(2).state({ role: "admin" }), "memberships").create();
// one user, two memberships with role "admin", and a team for each
```

- **The definition names a parent for both legs — that is the pattern, not a workaround.** Both relation fields of a join model are required, so a definition leaving one out does not compile. `has()` and `for()` replace the leg they select before anything is evaluated, so the factory standing there never runs and no stray record appears — the call above leaves exactly one user row.
- **Pivot attributes are ordinary typed columns**, so states reach them like any other attribute, as `.state({ role: "admin" })` does above.
- **The relation field may be left out**, each pair sharing exactly one relation through the join model: `userFactory.has(membershipFactory.count(2))` says the same thing.
- **`for()` works on the join model's own legs.** `membershipFactory.count(2).for(ada)` gives one user two memberships, each bringing a team of its own.
- **An existing row pins a leg.** `membershipFactory.state({ team })` reuses that team rather than drawing a new one.
- **Two records of the same pair collide** on the compound key. That is the schema being enforced, not a library bug.
- **An existing join-model row connects on its compound key.** A model whose only unique constraint is compound is matched on Prisma's generated compound selector — `{ userId_teamId: { … } }` — which the library builds from the row alongside its scalars, reading the constraint off the schema text the client carries. Every route a row reaches a relation field by connects alike: `has([membership])`, a row or a list of them standing in the field itself, and a row drawn from a [recycle](#recycle) pool. Connecting re-homes the row onto the new parent, the schema allowing.

## Recycle

`recycle()` pools rows that already exist: anywhere the graph would otherwise create a record of a pooled model, it connects a pooled row instead. The model is named outright — a row carries nothing that says which model it belongs to — and the name is a key of your client's models, so the row is checked against that model: one missing a required scalar is a compile error, and one loaded with `include` is accepted.

Here `Post.author` and `Post.editor` both point at `User`, and a comment reaches a user through its post:

```ts
export const postFactory = prismaFactorio.define("post", {
  definition: ({ uid }) => ({ title: uid, author: userFactory, editor: userFactory }),
});

export const commentFactory = prismaFactorio.define("comment", {
  definition: ({ uid }) => ({ body: uid, post: postFactory }),
});

const ada = await userFactory.create({ name: "Ada Lovelace" });
const comment = await commentFactory.recycle("user", ada).create();
```

`create()` returns the **comment**; the post behind it holds `ada` in both `author` and `editor`, two levels down, and no user is created. The same graph without `recycle()` draws two distinct users.

- **The pool covers the whole graph** — factories embedded in a definition or a state, `has()` children, and the graph under a `for()` parent, recursively; one call at the top reaches every level below it. It never self-populates: a record the graph creates is never adopted, so every pick comes from the rows you handed over. Nor does it stand in for the record you asked for — `commentFactory.recycle("comment", one)` still creates a comment.
- **`for()` and `create()` overrides beat the pool; a state does not.** What a call names outright — a parent, or the children of a relation field — is the caller's own choice and creates records of its own. A factory reaching a slot through the definition or through a state — declared or inline `.state()` — loses to the pool. Explicitness protects the immediate slot and nothing under it, so the pool still fills the sub-graph beneath a `for()` parent or an override factory.
- **Picks are per record, drawn with replacement**, from the library's own PRNG rather than from faker. A pool of two rows under `count(3)` is legal and hands the same row out twice — **there is no distinctness guarantee**. Across an implicit many-to-many, repeated picks collapse into a single join row.
- **Successive calls merge per model.** `recycle("user", a).recycle("user", b)` pools both, so a factory configured with a pool keeps its baseline rows when a call site adds more, and every model keeps a list of its own. A pool can be extended by an inner `recycle()` but never confined to a sub-graph: rows handed down from above reach the whole graph.
- **`seed` pins the picks as well as faker's values**, so one seed replays the same spread run for run. The picks belong to the graph that resolves them rather than to the bootstrap that defined the factory, so a factory reached from another bootstrap's graph draws from that graph's stream.
- **A pooled row can fill a relation field backed by a required foreign key once, and once only.** Connecting a row into such a field re-homes the record — Prisma rewrites the foreign key column it carries — while the pooled copy keeps the scalars it was pooled with, so the next record to draw that row matches on values the database no longer holds. The chain then fails with the library's own error naming this single-use rule, the raw Prisma error standing behind it as `cause`. Both routes carry it, `has()` layers and relation defaults alike, and picks come with no distinctness guarantee — so `userFactory.count(2).recycle("post", onePost).has(postFactory, "posts")` fails on the second user. Pool such a relation one parent record at a time, or pass native relation input. An implicit many-to-many is untouched, its join table leaving the rows it pairs alone — the pool is a fit for tags and a trap for posts. The root cause is the match itself: no single field of a row is knowably the one Prisma would match on, so the whole scalar row is the where-clause — values the rewrite left behind included.

**Children.** A child factory of a pooled model is never created, whether a `has()` layer brings it or it stands in the relation field: the drawn rows are connected in the parent's own create, and that factory's definition, states and callbacks never run.

```ts
const author = await userFactory.recycle("post", existingPosts).has(postFactory.count(3), "posts").create();
// one user, three picks from the pool, no post created
```

The count is the child chain's own batch size — one pick per record it would have created — so `has(postFactory.count(0))` draws nothing and leaves the relation field unwritten. `has([rows])` is untouched by any of this: rows connect as they always did.

## Callbacks

`afterCreating()` runs a side effect after every record a factory persists. Declare one in the config for a factory-wide effect, or add one to the chain at the call site:

```ts
export const userFactory = prismaFactorio.define("user", {
  definition: ({ faker, uid }) => ({ email: `user-${uid}@example.com`, name: faker.person.fullName() }),
  afterCreating: async (user, { client }) => {
    await client.post.create({ data: { title: "Welcome", author: { connect: { id: user.id } } } });
  },
});

const ada = await userFactory
  .afterCreating(async (user, { client }) => {
    await client.post.create({ data: { title: "Second", author: { connect: { id: user.id } } } });
  })
  .create();
// one user, two posts — the config's callback first, then the chain's
```

- **The callback receives the created row and the client the chain writes through.** The row carries its generated `id` and every database default; the client is the one `.using(tx)` named where a call named one, so a write the callback makes lands in the caller's transaction alongside the record. There is deliberately no global client to fall back on. Whatever the callback returns is awaited, then discarded.
- **The graph is complete when it fires.** A record's children are written before its callbacks run, whether a `has()` layer or a relation default brought them, and the callbacks of the parents it resolved have already run — so a graph fires parent side first, then the record itself, then each child's own callbacks, and the record's own last.
- **Config first, then chain order, one at a time.** A callback the config declared runs ahead of every callback the chain added, chain callbacks run in the order they were registered, and each is awaited before the next begins. `.afterCreating()` accumulates rather than replaces.
- **Once per record.** `count(3)` runs the whole list three times, each with its own row; `count(0)` runs it none. A `for()` parent is created once per `create()` call, so its callbacks run once however large the batch it answers.
- **A row the recycle pool stood in with fires nothing** — it was connected, never created.
- **`.afterCreating()` returns a new factory**, like every other fluent call, and states survive it in both chaining directions. Reusable callbacks can be typed with the exported `AfterCreating<Client, "model">`.
- **There is no `afterMaking()`**, `make()` not existing for it to follow — one of the [deviations from Laravel](#deviations-from-laravel).

## Seeding

The definitions a test suite already has are the ones a seed script runs: same factories, same file, imported unchanged. Only what is asked of them changes — volume, where a test asks for the two rows its assertion names. The `postFactory` and `commentFactory` below are the ones [Recycle](#recycle) declares:

```ts
// seed.ts
import { prisma } from "./db.js";
import { commentFactory, postFactory, userFactory } from "./factories.js";

const authors = await userFactory.count(5).create();

await postFactory.count(50).recycle("user", authors).has(commentFactory.count(2), "comments").create();

await prisma.$disconnect();
```

- **`count()` is the volume dial and `has()` the shape.** Fifty posts, two comments under each, and a `has()` on the child factory itself deepens the graph a level further.
- **`recycle()` is what keeps reference data from multiplying.** Without it each of the fifty posts draws an author and an editor of its own — a hundred users nobody asked for; with it every one of those slots connects a row from the five handed over. Pool the models a seed treats as fixed — the accounts, the tenants, the tags — and let the factories create the rest.
- **A seed script is an ordinary ESM module.** `initPrismaFactorio` binds the client exactly as it does under a test runner, so the bootstrap is the one in `factories.ts` and the script adds nothing but the calls and a closing `$disconnect()`.
- **A seeded run is not a reproducible one.** `seed` pins faker's values and the recycle picks and stops there — the warning under [Getting started](#getting-started) holds for a seed script exactly as it does for a test: every `uid`-derived column differs from run to run.

## Transactional tests

A test body that runs inside `prisma.$transaction` and ends by rolling back leaves the database as it found it, with nothing to truncate between tests. `.using(tx)` is what redirects the factory graph into that transaction:

```ts
// posts.test.ts
import { expect, test } from "vitest";
import { prisma } from "./db.js";
import { postFactory, userFactory } from "./factories.js";

class Rollback extends Error {}

test("an author reaches the posts written for them", async () => {
  await expect(
    prisma.$transaction(async (tx) => {
      const ada = await userFactory.using(tx).has(postFactory.count(2), "posts").create();

      const written = await tx.post.findMany({ where: { authorId: ada.id } });
      expect(written).toHaveLength(2);

      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
});
```

The sentinel is what commits nothing: the transaction callback only ever leaves by throwing, and the assertion around it swallows exactly that throw and no other.

- **The library opens no transaction of its own** — atomicity is the caller's ([ADR 0002](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0002-relation-wiring.md)). `.using()` names where records are written and does nothing else.
- **One `.using(tx)` covers the whole graph.** The user above, the two posts under it and anything a relation default drew for them all land in the one transaction, however deep the graph goes.
- **Hand over a client, not a bag of delegates.** `using(client: Pick<C, M>)` names a single delegate, but what travels down the graph is the client itself, so the argument has to be a generated client or a derivative that keeps its relation metadata. An interactive transaction's client is exactly that — Prisma builds it as a proxy over the client, stripping only `$connect`, `$disconnect`, `$on`, `$use` and `$extends`. A hand-built object of delegates keeps no metadata, so it type-checks and then throws `The client carries no relation metadata. Pass a generated Prisma client, not a hand-built object of delegates.` the moment the graph reaches a second model.
- **A throw inside the transaction callback rolls the whole graph back**, an `afterCreating` callback's throw included: a callback writes through the client the chain names, so its own records are in the transaction with everything else.
- **A transaction client is a different object**, so it pays an arity probe of its own — one `SELECT … LIMIT 1` per relation field a value stands in, once for the transaction rather than once per record ([ADR 0003](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0003-arity-through-the-query-surface.md)).

> [!NOTE]
> An interactive transaction is capped in duration. A graph large enough to outrun the cap aborts and rolls back rather than merely running slow; `prisma.$transaction(fn, { timeout })` raises it. That cap is why a large seed is better run bare.

## Deviations from Laravel

The feature set is Laravel's, ported to Prisma's semantics. Where the two part company it is a decision rather than a gap, and each one is here with the reason it was taken.

- **No magic relationship methods.** `hasPosts(3)` and `forUser()` resolve a model to its factory at call time, which needs a model→factory registry — and a registry filled by import side effects is at the mercy of ESM import order. Worth revisiting after v1 only with a design where an unregistered factory is a compile error rather than a runtime surprise. `has()` and `for()` name the factory outright meanwhile.
- **No `hasAttached()` and no pivot-attribute API.** An explicit join model composes through its own factory, where pivot attributes are ordinary typed columns a state reaches like any other; an implicit many-to-many has no pivot attributes to reach at all, Prisma's hidden join table carrying no extra columns by design. [Many-to-many](#many-to-many) shows both shapes.
- **No `make()` or `raw()`.** Without model classes there is no honest type for an unsaved record: a bag of attributes typed as a model row would promise the generated id and database defaults it does not carry. `create()` is the single verb; a weaker sibling is additive later if demand appears.
- **No `afterMaking()`.** Without `make()` there is nothing for it to follow.
- **No `sequence()`.** A state closure reads `index`, the record's own position in the batch, so alternating a column across a batch is one call rather than a second concept:

  ```ts
  await userFactory
    .count(10)
    .state(({ index }) => ({ name: index % 2 === 0 ? "Ada" : "Grace" }))
    .create();
  ```

- **No `trashed()`.** Prisma has no soft-delete concept for a built-in state to mean anything against. A model that implements one carries an ordinary column, which an ordinary state sets.
- **No polymorphic relations.** Prisma has no native equivalent, so there is nothing here to port.
- **No per-attribute lazy closures inside a definition.** The definition is one closure returning the whole attribute object, evaluated once per record — and everything a per-attribute closure would reach for, `faker` and `index` and `uid`, that one closure already holds.
- **No `createMany` fast path.** Records are written one `create` at a time, sequentially, because every relation feature depends on created-then-continue semantics: a child reads its parent's real row, a callback fires on a completed graph, and `create()` returns rows a batched write would never hand back ([ADR 0002](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0002-relation-wiring.md)).
- **No code generation of any kind** ([ADR 0001](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0001-no-library-codegen.md)). Laravel generates a factory class per model; here everything is inferred from the client you already generate, so there is no emitted file to drift from the schema and no build step to add to a consumer.
- **Magic state methods become declared, typed ones** — the deviation in the library's favour. Laravel answers `suspended()` at runtime through `__call`; here every key of the config's `states` object is mapped to a fluent method, so a typo is a compile error rather than a runtime one, as is a state naming a field the model does not have. See [States](#states).
- **A state does not beat `for()`; the call order does.** In Laravel a state applied anywhere in the chain takes the relation field from `for()`. Refusing that special case leaves one rule governing every layer of the chain — the order it was called in — which is what [Relations](#relations) demonstrates.

## Gotchas

Sharp edges worth knowing before they find you. The linked issues and ADRs carry the full background.

### Typing edges

- **Attributes are typed, but the merge is not.** States and overrides replace values key by key, last write wins. An override whose value is `undefined` is skipped, so the definition's value stands — `create({ name: cond ? "Ada" : undefined })` falls back to the definition rather than blanking the column. And Prisma's mutually exclusive create-input branches are only checked within a single object, so a definition using `author: { create: … }` combined with overrides passing `authorId` type-checks and then fails at runtime with `Unknown argument 'authorId'`.
- **A wrong-model row in a relation attribute is not caught.** A relation-valued attribute accepts Prisma's own nested relation input alongside a factory and a row, and that arm of the union leaves every key optional — so a row of the wrong model satisfies it vacuously. `postFactory.create({ author: teamRow })` compiles, at both arities and through every route an attribute is reached by. At runtime the row is filtered down to the target model's scalar names before it stands in the `connect` where-clause, so a `Team` row `{ id, slug }` collapses to `{ id }` — a perfectly good where-clause for a `User`. Where the target model holds no record of that id, the create fails loudly with Prisma's `P2025`; where it holds one — the ordinary case in a test database, ids starting at 1 per model — it silently connects the wrong record. What **is** caught: a wrong-model factory standing alone in the field (`postFactory.create({ author: teamFactory })` is a compile error, though one inside a list rides through), and a wrong-model row reaching a relation through `for()` or `has()` — `postFactory.for(teamRow, "author")` reports `ERROR: no belongs-to relation from "post" to "team"`. So prefer `for()` and `has()` where the choice exists; the structural fix is post-v1 research ([#48](https://github.com/flolefebvre/prisma-factorio/issues/48)).
- **Error shape.** A misspelled field reports `Type 'string' is not assignable to type 'never'` on the offending property — the same shape Prisma's own errors take. A wrong-model factory reports the same thing at length: a dozen-odd lines of assignability cascade unfolding Prisma's named input aliases, whose first line and property name carry every actionable word. Where no branch of the create input survives the object at all — an `id` beside a belongs-to relation field, say — the diagnostic collapses the other way, to `TS2345: … is not assignable to parameter of type 'undefined'`; that `'undefined'` is the exactness check refusing the whole argument, not a claim about the value you passed.
- **Faker's typing has one edge.** `faker` in the evaluation context is typed by a direct `import type` from `@faker-js/faker`. Without the package installed and with `skipLibCheck: false`, you get one `TS2307` from this package's type declarations; with `skipLibCheck: true` (which `tsc --init` leaves active) it compiles cleanly and the `faker` type degrades. Definitions that never mention `faker` run fine without the package; reading anything off `faker` without it throws an error naming what to install.
- **`CreateInput` is no longer a Prisma alias.** This package exports it, and changed what it means: a relation key now additionally accepts a `Factory`, a row, or a list of rows, so a value typed `CreateInput<Client, "model">` is no longer assignable to Prisma's own `create` `data` argument. If you imported it as a stand-in for Prisma's input type, it has stopped being one.

### Runtime edges

- **An explicit `id` and a belongs-to relation field cannot meet.** Prisma's _checked_ create input carries no `id`, so naming one forces the record into the _unchecked_ branch, which drops every relation field whose foreign key the model itself holds and demands those raw columns instead — the one thing [ADR 0002](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0002-relation-wiring.md) forbids this library writing. `postFactory.create({ id: 7 })` and `postFactory.create({ id: 7, authorId: 1 })` compile; `postFactory.create({ id: 7, author: { connect: { id: 1 } } })` is a compile error; and an `id` arriving through overrides while the relation comes from the definition type-checks, then fails at runtime with a Prisma validation error naming `id`. There is no workaround — this is Prisma's input shape meeting ADR 0002, not a gap here.
- **Connecting an existing row matches on the row's scalar fields.** A row parent's scalars are splatted into the `connect` where-clause — a relation the row was loaded with, as `include` hands back, is left out — because the runtime datamodel marks no field unique and no subset of a row is knowably the one Prisma would match on. A compound unique constraint the row can name whole joins them as Prisma's generated selector — `{ userId_teamId: { … } }` — read off the schema text the client carries, which is what lets a model whose only unique constraint is compound connect at all. Every field still narrows the match, so a row read _before_ the record changed fails loudly with Prisma's `P2025` rather than silently connecting to whatever the record has since become.
- **Reading a relation field's arity costs one query, once.** Prisma 7 publishes no arity at runtime, so the first time a factory or a list of rows stands in a given relation field the library puts the question to the query API instead. A field holding a single record answers for nothing — Prisma refuses the probe's filter before it reaches the database — and one holding many costs a single `SELECT … LIMIT 1`. The answer is held per field and per client, so the rest of the graph asks nothing, and a `.using(tx)` client asks once of its own ([ADR 0003](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0003-arity-through-the-query-surface.md)).
- **A column named after a relation operation shadows the row.** A parent row whose only key is a column literally named `connect`, `create`, `connectOrCreate` or `createMany` is read as native relation input rather than as a row, so pass native `{ connect: { … } }` explicitly for a model declaring one.
- **`.using(client)` rebinds the whole graph** — this factory's parents and children alike, however deep it goes; [Transactional tests](#transactional-tests) has the reach and the one thing the argument has to be. A factory that named a client through `.using()` of its own keeps it, and the factories it resolves in turn then run on that one. A factory that named none is rebound silently, one from a **different bootstrap** included: being bound at its own `initPrismaFactorio` counts for nothing here, exactly as a [recycle](#recycle) pool's picks belong to the graph resolving them rather than to the bootstrap that defined the factory.
- **A throwing callback is not caught.** `create()` rejects with the error the callback threw. Bare, the record the callback followed is already committed and stays standing — the rejection undoes nothing; under `.using(tx)`, the same throw leaves your transaction callback and the whole graph rolls back. That is [ADR 0002](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0002-relation-wiring.md)'s "atomicity is the caller's" composing as designed, not a special case.

## Status

**v1 scope complete, published as 0.1.0.** The scope [PRD #26](https://github.com/flolefebvre/prisma-factorio/issues/26) set for v1 is delivered, and this README documents the released surface rather than a plan. The version number is deliberately below 1.0.0 while the API meets its first consumers outside this repository; nothing on the list below is planned to change. What Laravel has and this does not is listed under [Deviations from Laravel](#deviations-from-laravel), each with the reason it was refused; the limitations that remain are named in the sections that own them.

The v1 surface: bootstrap from a client or a thunk with `seed` and `locale`, `define`, `create` with overrides, `count`, `using`, named states with inline `.state()`, the `{ faker, index, uid }` evaluation context, `for`, relation defaults on a field of either arity, `has` for the children on the other side, many-to-many in both shapes, `recycle` for reusing rows the graph would otherwise create, and `afterCreating` callbacks in the config and on the chain.

## Contributing

Bug reports, questions and ideas are welcome on the [issue tracker](https://github.com/flolefebvre/prisma-factorio/issues).

```bash
pnpm install
pnpm generate   # build the scratch Prisma client the tests run against
pnpm test       # vitest, against an in-memory SQLite database
pnpm gates      # full validation: generate, typecheck, lint, format, duplicates, test, build, packed contents
```

The project is developed test-first; tests sit next to the source they cover as `*.test.ts`. The domain vocabulary lives in [`CONTEXT.md`](CONTEXT.md) and the binding architecture decisions in [`docs/adr/`](docs/adr) — worth a read before proposing a change of direction. A pull request should pass `pnpm gates`.

Releases are cut from a version tag; [`docs/releasing.md`](docs/releasing.md) has the procedure.

## License

[MIT](LICENSE).
