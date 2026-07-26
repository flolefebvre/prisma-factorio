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

- A state is either a plain partial of the model's attributes or a closure returning one. A closure receives everything a definition gets, plus `attrs` — the attributes evaluated so far, the definition first and then the states already applied — and `parent`, the record this one is created for — the row a `has()` layer created just before reaching this factory, and `undefined` for a factory created on its own.
- **Every `states` key becomes a typed method.** `users.suspended()` autocompletes and `users.suspnded()` is a compile error, as is a state naming a field the model does not have or giving one the wrong type. This is the compile-checked replacement for Laravel's magic state methods.
- `.state(partialOrClosure)` applies a one-off transformation at the call site, typed exactly like a declared state.
- **Order of application:** the definition, then the states in the order they were applied, then `create(overrides)`. Last write wins per key, save for the relation field a [`has()`](#children) layer adds to rather than replaces; a key valued `undefined` is skipped at every layer, so the layer before it stands; a `null` is written.
- States evaluate once per record, so a closure in a `count(3)` chain sees each record's own `index` and `uid`.
- A state may not be named `create`, `count`, `using`, `state`, `for`, `has`, `recycle` or `then` — the first seven are methods the factory already answers to, and a factory carrying a `then` would be thenable and never settle when awaited. Either way the collision is a compile error and a `TypeError` at `define`.
- Declare states in the object you pass to `define`. Annotating that object with `FactoryConfig<Client, "model">` leaves the state names unknown to the compiler, which is why a config typed that way accepts no `states` at all.

### Relations

`for()` attaches every record a factory creates to one parent — a factory of the parent model, or a row of it:

```ts
const post = await posts.for(users, "author").create();

const ada = await users.create({ name: "Ada Lovelace" });
const byAda = await posts.for(ada, "author").create();
```

- **The relation field is checked against the pair of models.** It may be left out where the two share exactly one belongs-to relation, must be named where they share several, and no value satisfies it where they share none — a `for()` between two unrelated models is a compile error.
- **A relation value stands for one record.** A factory in a relation field holding many records is a compile error — in a definition, in a state and in `create()` overrides alike. The has-many side is reached through [`has()`](#children) instead, which is a method on the chain rather than a value.
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

### Children

`has()` fills a relation field holding many records, alongside every record the factory creates — a child factory, whose records are created for each parent record through that model's own `create`, or rows that already exist, connected as they stand and never re-created:

```ts
const author = await users.has(posts.count(3), "posts").create();
```

`create()` returns the **user**; the three posts are created after it, each reaching back to that user, and are not returned.

- **The relation field is checked against the pair of models**, exactly as `for()` checks it: it may be left out where the two share exactly one has-many relation, must be named where they share several, and no value satisfies it where they share none.
- **A child reads the record it was created for.** `parent` in a child's state closure is the created parent row — real `id`, database defaults included. Its type spans every model the client carries, so narrow it before reading a field only some of them declare.
- **`has()` adds, every other layer replaces.** Two calls on one relation field both apply, and a `has()` after a state adds to what that state left standing. A state or a `create()` override naming that field replaces it whole — a child factory so replaced creates nothing.
- **Ordering is depth-first.** Every child of one record is created before the next record of a batch, layer by layer in the order the calls were made.
- **`has(factory.count(0))` and `has([])` are legal**, and create the parent with nothing attached.
- **`inverse` names the relation field the child reaches its parent back through** — `users.has(posts, "posts", { inverse: "author" })` — for a relation whose two sides the client's metadata cannot pair down to one. It bypasses that lookup and nothing else.

**Batch cadence.** Children are created per parent record, where a `for()` parent is evaluated once per `create()` call:

```ts
await users.count(3).has(posts.count(2), "posts").create(); // 3 users, 6 posts — 2 each
await posts.count(3).for(users, "author").create(); // 3 posts, 1 user — shared
```

Same fluent shape, opposite multiplicity.

### Many-to-many

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
const post = await posts.has(tags.count(3)).create(); // three tags, all joined to the post
const tag = await tags.has(posts.count(2)).create(); // the same, read from the other end
await posts.has(existingTags).create(); // rows attach as they stand, no tag created
```

- **`has()` reads a many-to-many from whichever end reads better.** The two sides are an ordinary relation pair here, and the hidden join table adds no model of its own.
- **`for()` is a compile error at both ends, and that is correct.** Both sides hold many records, so the pair has no belongs-to side for `for()` to name — there is no sensible end to call it from.
- **The cadence is the usual one.** `posts.count(3).has(tags.count(2))` gives 3 posts and 6 tags, two each.
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
const memberships = f.define("membership", {
  definition: () => ({ role: "member", user: users, team: teams }),
});

const ada = await users.has(memberships.count(2).state({ role: "admin" }), "memberships").create();
// one user, two memberships with role "admin", and a team for each
```

- **The definition names a parent for both legs, and that is the pattern rather than a workaround.** Both relation fields of a join model are required, so a definition leaving one out does not compile. `has()` and `for()` replace the leg they select before anything is evaluated, so the factory standing there is never run and no stray record appears — the call above leaves exactly one user row.
- **Pivot attributes are ordinary typed columns**, so states reach them like any other attribute, as `.state({ role: "admin" })` does above.
- **The relation field may be left out**, each pair sharing exactly one relation through the join model: `users.has(memberships.count(2))` says the same thing.
- **`for()` works on the join model's own legs.** `memberships.count(2).for(ada)` gives one user two memberships, each bringing a team of its own.
- **An existing row pins a leg.** `memberships.state({ team })` reuses that team rather than drawing a new one.
- **Two records of the same pair collide** on the compound key. That is the schema being enforced, not a library bug.
- **Connecting an existing join-model row does not work yet.** A model whose only unique constraint is compound is matched on Prisma's generated compound selector — `{ userId_teamId: { … } }` — which a flat row of scalars does not satisfy, so `has([membership])` fails ([#41](https://github.com/flolefebvre/prisma-factorio/issues/41)). Pass native relation input meanwhile.

### Recycle

`recycle()` pools rows that already exist, so that anywhere the graph would otherwise create a record of that model it connects a pooled row instead. The model is named outright — a row carries nothing that says which model it belongs to — and the name is a key of your client's models, so the row is checked against that model: one missing a required scalar is a compile error, and one loaded with `include` is accepted. Here `Post.author` and `Post.editor` both point at `User`, and a comment reaches a user through its post:

```ts
export const posts = f.define("post", {
  definition: ({ uid }) => ({ title: uid, author: users, editor: users }),
});

export const comments = f.define("comment", { definition: ({ uid }) => ({ body: uid, post: posts }) });

const ada = await users.create({ name: "Ada Lovelace" });
const comment = await comments.recycle("user", ada).create();
```

`create()` returns the **comment**; the post behind it holds `ada` in both `author` and `editor`, two levels down, and no user is created. The same graph without `recycle()` draws two distinct users.

- **The pool covers the whole graph.** It reaches factories embedded in a definition or a state, `has()` children, and the graph under a `for()` parent, recursively — one call at the top reaches every level below it. It never self-populates: a record the graph creates is never adopted, so every pick comes from the rows you handed over. Nor does it stand in for the record you asked for — `comments.recycle("comment", one)` still creates a comment.
- **`for()` and `create()` overrides beat the pool; a state does not.** A parent the call names outright is the caller's own choice and creates its own record, and a row named there was never something the pool could stand in for. A factory reaching a slot through the definition **or through a state** — declared in the config or inline `.state()` — loses to the pool: a state is not explicit, whichever way it was written. Explicitness protects the immediate slot and nothing under it, so the pool still fills the sub-graph beneath a `for()` parent or an override factory.
- **Picks are per record, drawn with replacement**, from the library's own PRNG rather than from faker. A pool of two rows under `count(3)` is legal and hands the same row out twice — **there is no distinctness guarantee**, so do not rely on one. Across an implicit many-to-many, repeated picks collapse into a single join row.
- **Successive calls merge per model.** `recycle("user", a).recycle("user", b)` pools both, so a factory configured with a pool keeps its baseline rows when a call site adds more, and every model keeps a list of its own. A pool can be extended by an inner `recycle()` but never confined to a sub-graph: rows handed down from above reach the whole graph.
- **`seed` pins the picks as well as faker's values**, so one seed replays the same spread run for run. The picks belong to the graph that resolves them rather than to the bootstrap that defined the factory, so a factory reached from another bootstrap's graph draws from that graph's stream — the exception `initPrismaFactorio` documents.
- **A pooled row of a model whose only unique constraint is compound cannot be connected yet** ([#41](https://github.com/flolefebvre/prisma-factorio/issues/41)). It is matched on Prisma's generated compound selector, which a flat row of scalars does not satisfy, so a pooled `Membership` fails exactly as `has([membership])` does. Pass native relation input — `{ connect: { userId_teamId: { … } } }` — meanwhile.

**Children.** A `has()` child factory of a pooled model is never created: the layer connects drawn rows in the parent's own create, and that factory's definition and states never run.

```ts
const author = await users.recycle("post", existingPosts).has(posts.count(3), "posts").create();
// one user, three picks from the pool, no post created
```

The count is the child chain's own batch size — one pick per record it would have created — so `has(posts.count(0))` draws nothing and leaves the relation field unwritten. `has([rows])` is untouched by any of this: rows connect as they always did.

## Good to know

- **Every fluent call returns a new factory.** `users.count(3)` does not change `users`.
- **No implicit transaction.** Records are written one `create` call at a time, sequentially — never `createMany`. Atomicity is the caller's job: pass a transaction client with `.using(tx)`. This is a deliberate decision ([ADR 0002](docs/adr/0002-relation-wiring.md)), not an oversight.
- **Attributes are typed, but the merge is not.** States and overrides replace values key by key, last write wins. An override whose value is `undefined` is skipped, so the definition's value stands — `create({ name: cond ? "Ada" : undefined })` falls back to the definition rather than blanking the column. Prisma's mutually exclusive create-input branches are only checked within a single object, so a definition using `author: { create: … }` combined with overrides passing `authorId` type-checks and then fails at runtime with `Unknown argument 'authorId'`.
- **Error shape.** A misspelled field reports `Type 'string' is not assignable to type 'never'` on the offending property — the same shape Prisma's own errors take.
- **Faker's typing has one edge.** `faker` in the evaluation context is typed by a direct `import type` from `@faker-js/faker`. Without the package installed and with `skipLibCheck: false`, you get one `TS2307` from this package's type declarations; with `skipLibCheck: true` (which `tsc --init` leaves active) it compiles cleanly and the `faker` type degrades. Definitions that never mention `faker` run fine without the package; reading anything off `faker` without it throws an error naming what to install.
- **No `make()` or `raw()`.** `create()` is the single verb — a factory always writes to the database. This is a deliberate deviation from Laravel.
- **An explicit `id` and a belongs-to relation field cannot meet.** Prisma's _checked_ create input carries no `id`, so naming one forces the record into the _unchecked_ branch, which drops every relation field whose foreign key the model itself holds and demands those raw columns instead — the one thing [ADR 0002](docs/adr/0002-relation-wiring.md) forbids this library writing. `posts.create({ id: 7 })` and `posts.create({ id: 7, authorId: 1 })` compile; `posts.create({ id: 7, author: { connect: { id: 1 } } })` is a compile error; and an `id` arriving through overrides while the relation comes from the definition type-checks, then fails at runtime with a Prisma validation error naming `id`. There is no workaround — this is Prisma's input shape meeting ADR 0002, not a gap here.
- **Connecting an existing row matches on the row's scalar fields.** A row parent's scalars are splatted into the `connect` where-clause — a relation the row was loaded with, as `include` hands back, is left out — because the runtime datamodel marks no field unique and no subset of a row is knowably the one Prisma would match on. Every field therefore narrows the match, so a row read _before_ the record changed fails loudly with Prisma's `P2025` rather than silently connecting to whatever the record has since become.
- **A column named after a relation operation shadows the row.** A parent row whose only key is a column literally named `connect`, `create`, `connectOrCreate` or `createMany` is read as native relation input rather than as a row, so pass native `{ connect: { … } }` explicitly for a model declaring one.
- **`.using(client)` covers the whole graph.** It redirects not just this factory's records but every parent factory its creates resolve and every child factory a `has()` layer creates records through, however deep the graph goes — so one `.using(tx)` puts a whole factory graph in a single interactive transaction, and a rollback leaves nothing behind. A factory that named a client of its own keeps it, and the factories it resolves in turn then run on that one. The library still opens no transaction itself, exactly as [ADR 0002](docs/adr/0002-relation-wiring.md) says.
- **`CreateInput` is no longer a Prisma alias.** This package exports it, and this release changed what it means: a relation key now additionally accepts a `Factory` or a row, so a value typed `CreateInput<Client, "model">` is no longer assignable to Prisma's own `create` `data` argument. If you imported it as a stand-in for Prisma's input type, it has stopped being one.

## Status

v1 is in progress; this README tracks what actually works today.

Available now: bootstrap from a client or a thunk with `seed` and `locale`, `define`, `create` with overrides, `count`, `using`, named states with inline `.state()`, the `{ faker, index, uid }` evaluation context, `for` with relation defaults, `has` for the children on the other side, many-to-many in both shapes, and `recycle` for reusing rows the graph would otherwise create.

Tracked next: `afterCreating`.
