# Design proposal: prisma-factorio

Status: proposal. Every claim below was checked against Prisma 7.8 and TypeScript 6.0
with a working prototype in `sandbox/` (29 behaviour tests, plus type-level tests that
`tsc` asserts). Reproduce with `pnpm sandbox:verify`.

---

## 1. Goal

Let tests and seeds declare the records they need instead of writing every column:

```ts
const user = await userFactory.has("posts", 3).create();
//    ^? User & { posts: Post[] }
```

Laravel's factories are the reference (`docs/laravel-factories.md`). The port keeps
Laravel's model — a definition of defaults, named states, a fluent immutable builder,
relation helpers — and drops what does not exist in Prisma. Where TypeScript can do
better than PHP, it should: the shape of the returned record must reflect exactly what
the call created.

Three properties drive the design:

1. **No codegen.** Adding the package is enough; there is no generator to run, no
   generated file to commit, nothing to keep in sync with the schema.
2. **Typed from the client.** Model names, column names, value types, relation names
   and relation cardinality all come from the user's generated Prisma client.
3. **Precise results.** `create()` returns the record with exactly the relations the
   call asked for, and nothing else.

---

## 2. What Prisma 7 actually gives us

These were measured, not assumed. Prisma 7 changed enough that intuitions from
Prisma 5/6 are misleading.

### 2.1 `Prisma.dmmf` is gone

The `prisma-client` generator emits no `dmmf` export. Anything that reads the schema
at runtime has to find another source.

### 2.2 The runtime data model is slim

`client._runtimeDataModel` exists and survives transaction clients and `$extends`ed
clients. Each field carries only:

```json
{ "name": "author", "kind": "object", "type": "User", "relationName": "PostToUser" }
```

There is no `isRequired`, `isList`, `isId`, `hasDefaultValue`, `isUnique` or
`relationFromFields`. So the runtime knows the relation graph and nothing else.

`relationName` is the one fact that matters: it pairs `User.posts` with `Post.author`,
which is what lets a nested write drop the child's back-reference. Nothing else in the
design needs runtime metadata.

### 2.3 The public delegate surface is richer than expected

`prisma.user.name` is `"User"` — a public property giving the payload name, so the
`user` ⇄ `User` mapping never has to be guessed from casing rules. `prisma.user.fields`
lists scalar fields only (relations excluded).

### 2.4 The full schema text is on the client

`client._engineConfig.inlineSchema` holds the entire `.prisma` source as a string.
Not used by this design, but it is the escape hatch if complete metadata is ever needed
without a generator.

### 2.5 The type level is complete

`Prisma.Args`, `Prisma.Payload` and `Prisma.Result` — the helpers Prisma documents for
library authors — extract everything from a _delegate type_:

| Need                 | Source                                                   |
| -------------------- | -------------------------------------------------------- |
| create input         | `Args<C[M], "create">` → `{ data: … }`                   |
| scalar columns       | `Payload<C[M]>["scalars"]`                               |
| relation fields      | `Payload<C[M]>["objects"]`                               |
| related model        | `Payload<C[M]>["objects"][K]["name"]`                    |
| list vs to-one       | `Payload<C[M]>["objects"][K] extends readonly unknown[]` |
| result of an include | `Result<C[M], { include: … }, "create">`                 |

Model names are recovered structurally, so `$transaction` and friends are excluded:

```ts
type ModelName<C> = {
  [K in keyof C]: K extends string ? (C[K] extends AnyDelegate ? K : never) : never;
}[keyof C];
```

This is the whole reason no codegen is needed. A generic library can reach every type
in a user's schema starting from `typeof prisma` alone.

One trap: `Args<C[M], "create">["data"]` does not compile while the delegate is generic
(TS2536). It has to be inferred out: `Args<…> extends { data: infer D } ? D : never`.

---

## 3. What TypeScript allows

The API shape is not a matter of taste. Two measured compiler behaviours forced it.
Both are pinned in `sandbox/spec/typing-constraints.check.ts`, which fails to compile
if either stops being true.

### 3.1 Excess property checking does not reach a callback's return

```ts
declare function takesCallback(build: () => Row): void;
takesCallback(() => ({ a: "x", b: "y" })); // b is NOT reported
```

It is reported in value position, in argument position, in an array literal, and when
the function carries an explicit return type annotation — never through a contextual
return type. A definition written as `fields: (ctx) => ({ … })` therefore **cannot**
catch a misspelled column name. That is the worst possible failure: the column is
silently dropped and the test fails somewhere else.

→ **`fields` is a plain object, not a callback.** Values that need a counter or a
sibling field go through `lazy()` and `cycle()`.

### 3.2 Inferring the definitions object also loses the check

```ts
declare function inferred<C, D>(client: C, defs: D & { [K in keyof D]: … }): D;
inferred(prisma, { user: { fields: { name: "a", nickname: "c" } } }); // not reported
```

When `D` is inferred from the literal, the literal is its own contextual type, so
nothing is excess. Every variation of this — intersections, remapped constraints,
`const` type parameters — behaves the same as long as the values of `D` are inferred.

Naming the model in argument position fixes it, because `M` resolves before the
definition is checked:

```ts
define("user", { fields: { name: "a", nickname: "c" } });
//                                    ^^^^^^^^ Object literal may only specify known properties
```

→ **factories are declared one per call, with the model name as the first argument.**
State names still infer from the literal, so they can become methods.

### 3.3 The consequence: names or completeness, not both

Requiring the definition to be _complete_ (Laravel's contract) means inferring the
literal's type to test it against the create input — which is exactly what destroys
excess property checking. The two cannot coexist in one object literal.

This design picks name checking. A typo silently writes the wrong data; a missing
required column fails immediately with a clear Prisma error naming the column. See
§9 for the growth path that would recover both.

---

## 4. The API

### 4.1 A scope binds factories to a client

```ts
// tests/factories/scope.ts
import { factoryScope } from "prisma-factorio";
import { prisma } from "../prisma.ts";

export const { define, use, withClient, resetSequence } = factoryScope(prisma);
```

A scope owns the client, the sequence counter, and the registry that lets definitions
reference each other by model name.

### 4.2 Definitions

```ts
// tests/factories/user.ts
import { define, use } from "./scope.ts";
import { cycle, lazy } from "prisma-factorio";

export const userFactory = define("user", {
  fields: {
    name: lazy(({ seq }) => `User ${seq}`),
    email: lazy(({ seq }) => `user-${seq}@example.com`),
    role: "member",
  },
  states: {
    admin: { role: "admin" },
    unverified: { emailVerifiedAt: null },
  },
});

export const postFactory = define("post", {
  fields: {
    title: lazy(({ seq }) => `Post ${seq}`),
    content: lazy(({ attrs }) => `Body of ${String(attrs["title"])}`),
    author: use("user"),
  },
  states: { published: { published: true } },
});
```

`define` returns a factory that is usable immediately. `use("user")` is a lazy
reference resolved when a record is built, so definitions may point at each other in
any order, including cycles.

Field values may be:

| Value           | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| a literal       | used as-is                                                                                             |
| `lazy(fn)`      | resolved per record; `fn` receives `{ seq, index, attrs }`, where `attrs` is `Record<string, unknown>` |
| `cycle(a, b)`   | alternates across the batch, one value per record                                                      |
| `use("model")`  | creates a related record through this relation                                                         |
| another factory | same, with states or counts applied                                                                    |

`lazy` and `cycle` are declared as returning the field's own type, so the definition
stays fully checked while the runtime value is a marker object.

### 4.3 Building records

```ts
await userFactory.create(); // User
await userFactory.count(3).create(); // User[]
await userFactory.admin().create(); // named state
await userFactory.state({ role: "editor" }).create();
await userFactory.create({ name: "Ada" }); // call-site override
await userFactory.count(4).sequence({ role: "a" }, { role: "b" }).create();
await userFactory.build(); // create input, nothing written
```

Named states become methods on the factory, typed from the definition. `suspended()`
does not compile unless `suspended` is declared.

### 4.4 Relations

```ts
// has: create children on a to-many relation
await userFactory.has("posts", 3).create();
await userFactory.has("posts", postFactory.count(2).published()).create();

// for: attach every record in the batch to one parent on a to-one relation
await postFactory.count(3).for("author", userFactory).create();
await postFactory.count(3).for("author", existingUser).create();

// attach: connect records that already exist
await postFactory.attach("tags", ...existingTags).create();

// recycle: reuse one record everywhere its model is needed
await ticketFactory.recycle("airline", airline).create();
```

`has` only accepts list relations, `for` only accepts to-one relations, and both check
that the factory or record belongs to the related model — all from the client's types.

### 4.5 Hooks

```ts
define("user", {
  fields: { … },
  afterBuild: (data) => { … },   // before the insert, on the resolved data
  afterCreate: (user) => { … },  // after the insert, on the record
});

await userFactory.afterCreate(async (user) => { … }).create();
```

Hooks declared on a factory passed to `has()` run for each child created.

### 4.6 Clients and transactions

```ts
await postFactory.using(tx).create();               // one factory
await withClient(tx, async () => { … });            // every factory in the scope
```

`withClient` rebinds factories that were declared before the transaction existed, which
is what a transaction-per-test setup needs.

---

## 5. Semantics

### 5.1 Resolution order

For each record in a batch:

1. the definition's `fields`
2. each `state()` layer, in call order (named states are ordinary layers)
3. the `sequence()` layer for this batch position
4. the overrides passed to `create()` / `build()`
5. markers expand in declaration order — `lazy` sees the fields resolved before it
6. `for` and `attach` overwrite their relation keys
7. `has` children are resolved recursively and nested under the relation key
8. `afterBuild` hooks

Later layers win. `seq` increments once per record and is scope-wide;
`resetSequence()` restarts it for deterministic runs.

### 5.2 One parent or one per record

This distinction is inherited from Laravel and is easy to get wrong:

- **`for("author", userFactory)`** resolves the parent **once** for the whole batch.
  `count(3).for("author", userFactory)` creates one user and three posts.
- **`author: use("user")` in the definition** resolves **per record**.
  `count(3)` creates three users and three posts.

Both are verified in `sandbox/spec/usage.test.ts`.

### 5.3 Relations become nested writes

`has` compiles to a Prisma nested write:

```ts
prisma.user.create({
  data: { …user, posts: { create: [ …post1, …post2 ] } },
  include: { posts: true },
});
```

The child's back-reference is stripped before nesting. The Post definition sets
`author: use("user")`; nested under `user.posts`, that key is removed because
`relationName` identifies `author` as the inverse of `posts`. This is the only place
runtime metadata is used, and it is what makes a child factory reusable both standalone
and nested.

Nesting is recursive, so `user.has("posts", postFactory.has("taggings", 1))` produces
one statement and one correctly typed result.

Implicit many-to-many works unchanged (`post.has("tags", 2)`). Pivot columns are
reached through the explicit join model
(`post.has("taggings", taggingFactory.state({ public: false }))`).

Two relations between the same pair of models stay apart, because `relationName`
distinguishes them: `user.has("posts", …)` fills `Post.author` and
`user.has("reviewed", …)` fills `Post.reviewer`. Self relations work in both directions
(`user.has("reports", 2)`, `user.for("manager", userFactory)`); the inverse lookup has
to exclude the field itself, since both sides of a self relation live on the same model
and share a relation name. All four cases are covered in
`sandbox/spec/hard-relations.test.ts`, and the lookup is pinned in both field orders in
`sandbox/spec/metadata.test.ts`.

### 5.4 Results carry exactly what the call declared

Every `has`, `for` and `attach` adds to an include accumulated in the factory's type,
and `create()` returns `Result<C[M], { include: Inc }, "create">`:

```ts
const user = await userFactory.has("posts", postFactory.count(2).has("taggings", 1)).create();
//    ^? User & { posts: (Post & { taggings: Tagging[] })[] }
```

Relations created by the _definition_ are not included and do not appear on the type.
The rule is: the call site declares what it wants back.

### 5.5 Atomicity

A call that issues more than one statement (`count(n > 1)`, or any `for`) runs inside
`$transaction`, so a failure part-way through leaves nothing behind. A client already
inside an interactive transaction has no `$transaction` property, which naturally ends
the recursion.

### 5.6 Connecting to existing records

`for`, `attach` and `recycle` need a `where`-unique for a record they were handed. The
default is `{ id: record.id }`. Models with a composite or renamed primary key supply
one:

```ts
factoryScope(prisma, {
  identify: (record, model) =>
    model === "Tagging" ? { postId_tagId: { postId: record.postId, tagId: record.tagId } } : { id: record.id },
});
```

Without runtime metadata the primary key cannot be discovered, so this is explicit
rather than magic. The error message names the model when it is missing.

---

## 6. Architecture

```
src/
  index.ts        factoryScope, lazy, cycle, public types
  types.ts        type plumbing over an unknown PrismaClient
  factory.ts      the builder's type (no runtime)
  markers.ts      lazy / cycle / factory-reference markers
  metadata.ts     relation graph read from the client
  runtime.ts      resolution, nesting, persistence
```

The dependency direction is one-way: `types.ts` knows only Prisma's type helpers,
`factory.ts` knows `types.ts`, `runtime.ts` knows everything and is the only module
that touches the client. `factory.ts` carries the whole public builder type and has no
runtime counterpart, which keeps the type accumulators (`Inc`, `Card`, `S`) readable in
one place.

The builder is immutable: every method returns a new factory with a patched plan, so
factories are safe to share across tests and to store in module scope.

---

## 7. Decisions

| Decision                              | Why                                                                      | Alternative rejected                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| No codegen                            | `Prisma.Args`/`Payload`/`Result` expose everything from `typeof prisma`  | A Prisma generator: another build step and another thing to keep in sync, for facts we do not need in v1 |
| `fields` is an object, not a callback | callbacks lose excess property checking (§3.1)                           | `fields: (ctx) => ({ … })`, familiar from Laravel but unable to catch typos                              |
| One `define` call per model           | naming the model fixes `M` before the literal is checked (§3.2)          | a single `defineFactories({ user: …, post: … })` object, which loses the check                           |
| Definitions may be partial            | completeness and name checking are mutually exclusive (§3.3)             | requiring complete definitions, trading a common failure for a rare one                                  |
| `use("model")` for cross-references   | resolved by name at build time, so any declaration order and cycles work | importing the other factory directly, which breaks on module cycles                                      |
| Named states as methods               | reads like Laravel, and the compiler knows the state names               | `state("admin")` with a string, which is checkable but noisier                                           |
| `has` includes, definitions do not    | the call site declares what it wants back; results stay lean             | including every relation, which would make every result type enormous                                    |
| `build()` returns the create input    | DB defaults (`autoincrement`, `now()`) are unknown without metadata      | pretending to return a full model with invented ids                                                      |
| No faker dependency                   | definitions import whatever generator they like; nothing is bundled      | a peer dependency on `@faker-js/faker` for a `fake()` helper                                             |
| `identify` option for `connect`       | the primary key is not discoverable at runtime                           | assuming `id` everywhere, which breaks composite keys silently                                           |

---

## 8. Laravel feature mapping

| Laravel                         | Here                                | Note                                                 |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `definition()`                  | `define(model, { fields })`         | declarative rather than a method                     |
| `fake()`                        | —                                   | bring your own generator                             |
| state methods                   | `states: { … }` → `factory.admin()` | typed from the definition                            |
| `state([…])` / `state(fn)`      | `state({ … })`                      | closures replaced by `lazy()` inside the patch       |
| `trashed()`                     | —                                   | soft delete is not a Prisma concept; declare a state |
| `afterMaking` / `afterCreating` | `afterBuild` / `afterCreate`        | both declarable and chainable                        |
| `make()`                        | `build()`                           | returns create input, not a hydrated model           |
| `create()`                      | `create()`                          | typed by the relations declared                      |
| `count(n)`                      | `count(n)`                          | switches the result to an array                      |
| `Sequence`                      | `sequence(…)` / `cycle(…)`          | `sequence` is a state layer, `cycle` a field value   |
| `has(Post::factory())`          | `has("posts", …)`                   | relation named explicitly and checked                |
| magic `hasPosts(3)`             | `has("posts", 3)`                   | no magic methods; the same brevity                   |
| `for(User::factory())`          | `for("author", …)`                  | one parent per batch, as in Laravel                  |
| `hasAttached(models)`           | `attach("tags", …records)`          | connects existing records                            |
| pivot attributes                | explicit join model + `has`         | Prisma models the pivot as a model                   |
| polymorphic relations           | —                                   | not a Prisma concept                                 |
| `recycle()`                     | `recycle(model, …records)`          | model named explicitly; plain objects carry no class |

---

## 9. Limitations and risks

**`_runtimeDataModel` is a private property.** It is the only private API used, it is
read once per scope, and it is needed for one thing: pairing a relation with its
inverse. Mitigations: pin the `@prisma/client` peer range, keep a smoke test that fails
loudly with an actionable message, and allow an explicit override
(`has("posts", …, { inverse: "author" })`) as an escape hatch. If it ever disappears,
`_engineConfig.inlineSchema` (§2.4) and a generator are both fallbacks.

**Definitions are not checked for completeness.** A missing required column surfaces as
a Prisma validation error naming the column. See §3.3.

**Raw foreign keys do not nest.** A definition that sets `authorId: 1` instead of
`author: use("user")` cannot be nested under `user.has("posts", …)`, because the FK
name is not discoverable at runtime. Definitions should use relation fields.

**Factories must be imported before they are used.** `use("user")` and `has("posts", 3)`
resolve through the scope's registry, so a barrel file that imports every definition is
the recommended layout. The error names the missing model.

**`recycle` picks randomly** from a pool of several records, matching Laravel. For
deterministic tests the scope should accept a `random` option.

**Growth path.** An _optional_ Prisma generator would add what the runtime cannot see:
required columns, defaults, unique keys and foreign keys. That would unlock compile-time
completeness checking (a per-model definition type with exact required keys, no XOR and
no inference, so §3.3's trade-off disappears), automatic `identify`, full-object
`build()`, and scaffolding a starter factory per model. The core stays codegen-free; the
generator only sharpens it.

---

## 10. Suggested implementation slices

Each slice is independently testable and ships something usable.

1. **Type plumbing** — `ModelName`, `CreateData`, relation types, `Produced`; the
   assertions in `types.check.ts` are the acceptance test.
2. **Scope and definitions** — `factoryScope`, `define`, `fields`, `build()`, with the
   excess-property behaviour pinned by `typing-constraints.check.ts`.
3. **Persistence** — `create()`, `count()`, overrides.
4. **States** — declared states as methods, `state()`, `sequence()`.
5. **Markers** — `lazy`, `cycle`, and factory references via `use`.
6. **Metadata** — the relation graph and inverse resolution, including self relations
   and two relations between one pair of models.
7. **`has`** — nested writes, include accumulation, recursion.
8. **`for` / `attach`** — single-parent semantics, `identify`.
9. **`recycle`** — pool inheritance into nested factories.
10. **Hooks** — `afterBuild` / `afterCreate`, including for nested children.
11. **Transactions** — `using`, `withClient`, atomic multi-statement calls.

---

## 11. Reproducing the prototype

```
pnpm install
pnpm sandbox:verify     # generate client + migrate, typecheck, run tests
```

- `sandbox/prisma/schema.prisma` — a schema covering to-one, to-many, implicit m2m,
  an explicit pivot with a composite key, and the Airline/Flight/Ticket shape from the
  Laravel `recycle` example.
- `sandbox/lib/` — the prototype, structured as §6 proposes.
- `sandbox/spec/factories.ts` — definitions in the proposed API.
- `sandbox/spec/usage.test.ts` — behaviour tests against SQLite.
- `sandbox/spec/hard-relations.test.ts` — self relations and two relations between the
  same pair of models.
- `sandbox/spec/metadata.test.ts` — inverse resolution, against a stubbed data model.
- `sandbox/spec/types.check.ts` — result types and rejected usage; `tsc` asserts.
- `sandbox/spec/typing-constraints.check.ts` — the compiler behaviours from §3.

The prototype is a design artifact, not a candidate implementation: it skips input
validation, error message polish, and concurrency. It does cover the relation shapes
that are easiest to get wrong — self relations, two relations between one pair of
models, implicit many-to-many, and an explicit pivot with a composite key.
