# Design proposal: prisma-factorio

Status: proposal, verified by an executable spike. Not yet implemented in `src/`.

This document proposes an API and an architecture for a Laravel-style model factory library for
Prisma. Every claim marked **verified** is backed by the spike in `prototype/`, which compiles under
the project's `strict` TypeScript settings and runs 25 tests against a real SQLite database. Run
`pnpm prototype:verify` to reproduce.

---

## 1. What the port has to achieve

`docs/laravel-factories.md` is the reference. The valuable parts of Laravel factories are:

- a **default definition** per model, so tests declare only what they care about;
- **named states** that compose (`User::factory()->suspended()->admin()`);
- **counts** and **sequences** for batches;
- **relations** built fluently (`has`, `for`, `hasAttached`, `recycle`);
- **hooks** after making and after creating.

Laravel gets there through PHP dynamism: magic `__call` methods, untyped arrays, and Eloquent's
runtime relation metadata. None of those three are available to us. The design below reaches the
same ergonomics through TypeScript inference and Prisma's nested writes instead.

---

## 2. The constraint that shapes everything

Before designing the API I checked what Prisma 7.8 actually gives a library at runtime and at the
type level. The answer decides the architecture, so it is worth stating plainly.

### 2.1 Runtime schema metadata is not usable — **verified**

Prisma 7 replaced the old DMMF with a _pruned_ runtime data model. `Prisma.dmmf` no longer exists.
What survives, on the private `prisma._runtimeDataModel`, is only:

```json
{ "name": "posts", "kind": "object", "type": "Post", "relationName": "PostToUser" }
```

Stripped out: `isList`, `isRequired`, `isId`, `isUnique`, `hasDefaultValue`,
`relationFromFields` / `relationToFields`, `primaryKey`, `uniqueFields`. A one-to-many `posts Post[]`
and a nullable one-to-one `profile Profile?` are **byte-for-byte identical** in this structure.
Pruning is unconditional in the generator — there is no flag to disable it.

The only complete runtime source is `prisma._engineConfig.inlineSchema`, the raw schema text, on a
private field, with no exported parser.

**Consequence: the library must not depend on runtime schema introspection.** Anything built on
`_runtimeDataModel` would rest on private, deliberately-reduced internals.

### 2.2 The type level is rich and fully sufficient — **verified**

Everything the design needs can be derived from the _user's own client type_, with no code
generation and no configuration:

| Needed                               | Derived from                                      |
| ------------------------------------ | ------------------------------------------------- |
| model keys (`"user" \| "post" \| …`) | delegates on the client that expose `create`      |
| create input (`UserCreateInput`)     | `create()`'s `args.data`                          |
| persisted row type                   | `create()`'s awaited return                       |
| unique selector                      | `findUnique()`'s `args.where`                     |
| which fields are relations           | create-input fields that accept a nested `create` |
| relation target model                | the field's `connect` selector                    |

These are precise, not `any`: the spike asserts that unknown fields, missing required fields and
wrong value types are all rejected, and that the row type is **exactly** the generated model type.

### 2.3 The resulting architecture

1. **No codegen, no CLI, no generator plugin.** The package is a plain library; users keep their
   existing `prisma generate`.
2. **Generic over the client type.** `defineFactory(prisma, "user", …)` infers everything from
   `typeof prisma`. Works with any output path, any generator, custom clients and extensions.
3. **Relations compile to Prisma nested writes.** The query engine resolves foreign keys, so the
   library never needs to know what a foreign key _is_. A parent and its children are inserted in
   one atomic statement.

This is the central bet of the design, and it is what makes the missing runtime metadata a
non-issue rather than a blocker.

---

## 3. Proposed API

### 3.1 Defining a factory

```ts
import { defineFactory } from "prisma-factorio";
import { prisma } from "./client";

export const userFactory = defineFactory(prisma, "user", {
  define: ({ seq }) => ({
    email: `user${seq}@example.com`,
    name: "Jane Doe",
  }),
  states: {
    admin: () => ({ role: "admin" }),
    unverified: () => ({ verifiedAt: null }),
    named: (name: string) => ({ name }),
  },
});
```

`define` receives a `ResolveContext`:

- `seq` — a monotonic counter, unique per factory for the process lifetime. This is how uniqueness
  is achieved without bundling Faker: `email: \`user${seq}@example.com\`` is unique by construction.
- `index` — 0-based position within the current batch.

`states` replaces Laravel's magic state methods. Each entry becomes a **chainable, typed method**,
may take arguments, and preserves cardinality.

### 3.2 Using a factory

```ts
await userFactory.create(); // Promise<User>
await userFactory.count(3).create(); // Promise<User[]>
await userFactory.admin().unverified().create(); // states compose
await userFactory.named("Jessica").create(); // state arguments
await userFactory.create({ name: "Abigail" }); // inline overrides
userFactory.make(); // no database access
```

`count()` flips the return type from `T` to `T[]` — **verified**, including that `count(1)` returns a
one-element array rather than a bare object.

Factories are **immutable**: every method returns a new builder, so `userFactory.admin()` never
contaminates the shared `userFactory`. **Verified** by test.

### 3.3 Values: literals, per-field functions, nested factories

Any attribute — in `define`, `state`, `sequence` or an override — may be:

```ts
{
  title: "Hello",                                   // a literal
  slug: (attrs) => slugify(String(attrs.title)),    // a function of the attributes so far
  author: userFactory,                              // a nested factory
}
```

Per-field functions are evaluated in declaration order and receive the attributes resolved so far,
so later fields can depend on earlier ones. This replaces Laravel's whole-array closure
(`state(fn (array $attributes) => …)`); see §6.2 for why that form was dropped.

### 3.4 Relations

```ts
// belongs-to, declared in the definition (the Laravel-recommended style)
export const postFactory = defineFactory(prisma, "post", {
  define: ({ seq }) => ({ title: `Post ${seq}`, body: "…", author: userFactory }),
});

// has-many
await userFactory.with("posts", postFactory.count(3)).create();

// many-to-many
await postFactory.with("tags", tagFactory.count(2)).create();

// connect an existing row — a raw Prisma nested write, fully typed
await postFactory
  .count(2)
  .with("author", { connect: { id: author.id } })
  .create();
```

A single `with(field, spec)` replaces Laravel's `has` / `for` / `hasAttached` trio. Laravel needs
three verbs because it must infer direction and pivot handling at runtime; here the create-input
type already encodes direction, cardinality and pivot shape, so one verb is unambiguous and better
typed. Explicit pivot models are just factories on the join model.

The relation field name is constrained to real relations of the model, and the factory must target
the compatible model — **verified**, including that `userFactory.with("email", …)` (a scalar) and
`userFactory.with("posts", teamFactory)` (wrong model) are both compile errors.

`recycle` mirrors Laravel: every nested factory targeting that model connects to the supplied row(s)
instead of creating new ones.

```ts
const author = await userFactory.create();
await postFactory.count(3).recycle("user", author).create(); // all three share the author
```

### 3.5 Sequences and hooks

```ts
await userFactory.count(4).sequence({ role: "admin" }, { role: "guest" }).create();
await userFactory
  .count(3)
  .sequence({ name: (_a, ctx) => `Name ${ctx.index}` })
  .create();

userFactory.afterMaking((data) => {
  /* resolved attributes */
});
userFactory.afterCreating(async (row) => {
  /* persisted row, typed */
});
```

### 3.6 Full surface

```ts
function defineFactory<C, K extends ModelKey<C>, D, S extends StateMap>(
  client: C,
  model: K,
  options: {
    define: (ctx: ResolveContext) => Exact<C, K, D>;
    states?: S;
    identify?: (row: Model<C, K>) => WhereUnique<C, K>;
  },
): Factory<C, K, S, "one">;

interface FactoryMethods<C, K, S, Card> {
  count(n: number): Factory<C, K, S, "many">;
  state<T>(patch: Exact<C, K, T>): Factory<C, K, S, Card>;
  sequence<T>(...entries: Exact<C, K, T>[]): Factory<C, K, S, Card>;
  with<F extends RelationKey<C, K>>(
    field: F,
    spec: RelatedFactory<C, K, F> | CreateInput<C, K>[F],
  ): Factory<C, K, S, Card>;
  recycle<MK extends ModelKey<C>>(model: MK, rows: Model<C, MK> | Model<C, MK>[]): Factory<C, K, S, Card>;
  afterMaking(hook: (data: CreateInput<C, K>) => void): Factory<C, K, S, Card>;
  afterCreating(hook: (row: Model<C, K>) => void | Promise<void>): Factory<C, K, S, Card>;
  make<T>(overrides?: Exact<C, K, T>): Card extends "many" ? CreateInput<C, K>[] : CreateInput<C, K>;
  create<T>(overrides?: Exact<C, K, T>): Promise<Card extends "many" ? Model<C, K>[] : Model<C, K>>;
}
```

`identify` tells `recycle` and connect-style relations how to build a unique selector from a row. It
defaults to `{ id }`, which covers the overwhelming majority of schemas; models keyed differently
(including composite keys) declare it explicitly. The runtime cannot discover the primary key
(§2.1), so this is the one piece of schema knowledge the user must supply — and only when they use
the features that need it.

---

## 4. Resolution semantics

For each record in a batch, in this order:

1. build `ResolveContext` (`index`, fresh `seq`);
2. evaluate `define(ctx)` into a raw attribute map;
3. apply steps in the order the builder methods were called — `state`, `sequence`, `with`, `recycle`;
4. expand values in declaration order: per-field functions are invoked with the attributes resolved
   so far; nested factories become nested writes;
5. merge inline overrides passed to `make`/`create`;
6. run `afterMaking`;
7. `create` only: insert via `client[model].create({ data })`, then run `afterCreating`.

A nested factory becomes `{ create: … }`, or `{ connect: identify(row) }` when the recycle pool
holds a row for that model.

### The inverse-relation rule

This one is not obvious and the spike found it the hard way. Given:

```ts
const postFactory = defineFactory(prisma, "post", {
  define: () => ({ title: "…", body: "…", author: userFactory }),
});

await userFactory.with("posts", postFactory.count(3)).create();
```

Prisma types the nested payload as `PostCreateWithoutAuthorInput` — `author` is **forbidden** there,
because the parent supplies it. Sending it fails with ``Unknown argument `author` ``.

**Rule: when a factory is nested under a parent, any definition value that is itself a factory for
the parent's model is dropped.** The nesting already implies the back-reference. This needs no schema
metadata — the library knows each nested factory's own model key. **Verified**: this is what makes
`define`-declared belongs-to relations compose with `with()`.

Known limitation: a model with _two_ relations to the same model (say `Post.author` and
`Post.reviewer`, both `User`) cannot distinguish them by model key alone, and both would be dropped.
See §7.

---

## 5. Laravel parity

| Laravel                             | Proposal                         | Notes                                          |
| ----------------------------------- | -------------------------------- | ---------------------------------------------- |
| `definition()`                      | `define`                         |                                                |
| state methods                       | `states` map → chainable methods | typed, arguments supported                     |
| `state([...])` / `state(fn)`        | `.state({...})`                  | per-field functions replace array closures     |
| `count(n)`                          | `.count(n)`                      | flips the return type                          |
| `make()` / `create()`               | same                             |                                                |
| `sequence(...)`                     | `.sequence(...)`                 | `ctx.index` available                          |
| `afterMaking` / `afterCreating`     | same                             | typed row                                      |
| `has()` / `hasAttached()` / `for()` | `.with(field, spec)`             | one verb; direction comes from the type        |
| magic `hasPosts()` / `forUser()`    | `.with("posts", …)`              | no magic methods in TS; keys are autocompleted |
| factory as a definition value       | same                             |                                                |
| `recycle()`                         | `.recycle(model, rows)`          | model key is explicit                          |
| `fake()`                            | not bundled                      | see §7                                         |
| `trashed()`                         | not applicable                   | Prisma has no built-in soft deletes            |
| polymorphic relations               | not applicable                   | Prisma has no polymorphic relations            |

---

## 6. Type safety: what is guaranteed, and what is not

### 6.1 Guaranteed — **verified** by `prototype/src/types.test-d.ts`

Compile errors are produced for: unknown model keys; unknown field names in `define`, `state`,
`sequence` and overrides; wrong value types; per-field functions returning the wrong type; undeclared
state methods; wrong state arguments; non-relation field names in `with`; factories targeting the
wrong model; invalid `connect` selectors; and treating a `count()` result as a single record.

Two non-obvious mechanisms make this work, and both belong in the spec:

- **`Exact<C, K, T>`.** TypeScript applies excess-property checking only to object literals in a
  _direct assignment_ — never to a literal returned from a callback or inferred through a generic.
  Without an explicit `T & Record<Exclude<keyof T, FieldName>, never>` guard, a field-name typo in
  `define` compiles cleanly and fails only at runtime. **Verified** both ways.
- **Relation targets are matched through the `connect` selector**, not through the model key. A
  factory for model `MK` fits relation field `F` only when `WhereUnique<C, MK>` is accepted by `F`'s
  `connect`. Caveat: two models with structurally identical unique selectors (both just
  `{ id?: number }`) are interchangeable at this check. It is a real but minor hole.

### 6.2 Why whole-object state closures were dropped

Laravel's `state(fn (array $attributes) => [...])` cannot be typed safely here. `Attributes` is an
all-optional object type, so a _function_ is structurally assignable to it; an overload accepting
objects therefore swallows closures and type-checks them vacuously. I tried overload ordering,
function-excluding conditionals and self-referencing constraints — **all verified to fail**, either
letting typos through or, worse, letting wrong value types through.

Per-field functions have none of these problems, are _more_ precisely typed (each function's return
type is checked against its own field), and read the same as the definition syntax. Recommending
them is a genuine improvement over the Laravel original, not a compromise.

---

## 7. Open decisions

These need your call before specs are written. Each has a recommendation.

1. **Batch atomicity.** The spike inserts a batch sequentially. Recommend wrapping
   `create()` batches in `client.$transaction([...])` so a batch is all-or-nothing. Needs the
   transaction method surfaced in the client type constraint.
2. **Faker.** Recommend _not_ depending on it: keep `seq` for uniqueness and let users call whatever
   generator they like inside `define`. Optionally document a Faker recipe.
3. **Determinism.** No seeding today. Recommend an optional per-run seed so `recycle`'s random pick
   and any user randomness can be reproduced.
4. **`make()`'s return shape.** Currently the resolved _create input_, so nested relations appear as
   `{ create: {...} }` rather than plain objects. Defensible (it is exactly what would be sent), but
   worth confirming that is what you want from `make()`.
5. **Two relations to the same model.** The inverse-relation rule (§4) and `recycle` both key on the
   model, so `Post.author` and `Post.reviewer` are indistinguishable. Recommend an explicit escape
   hatch — naming the relation field — for these schemas.
6. **`identify` when there is no `id`.** The `{ id }` default is not type-checked. Recommend making
   `identify` _required_ at the type level when the model's unique selector does not accept `{ id }`.
7. **Cardinality mismatch in relations.** `.with("author", factory.count(3))` on a to-one relation
   builds an array payload and Prisma rejects it at runtime. Could be a compile error with more type
   work; recommend deferring.
8. **Cross-file organisation.** Factories are plain values, so they compose by import. Consider
   whether a registry (`defineFactories(prisma, {...})`) is worth it for discoverability.

---

## 8. What the spike proves

`prototype/` is a working slice, not a finished library. It is deliberately kept out of `src/` so the
implementing agent starts clean.

```
prototype/
  prisma/schema.prisma   7 models: 1-1, 1-n, implicit m-n, explicit pivot w/ composite key
  lib/                   types.ts, factory.ts (engine), index.ts (typed facade)
  src/                   factories.ts, factory.test.ts, edge.test.ts, types.test-d.ts
```

`pnpm prototype:verify` regenerates the client, pushes the schema, type-checks (including ~25
negative type assertions) and runs **25 passing tests** covering: make/create, counts, overrides,
declared and inline states, state composition and immutability, sequences, belongs-to via definition,
has-many, many-to-many, explicit pivot models, connect-to-existing, recycle, hooks, and cardinality
edge cases.

Two real bugs were found and fixed this way — the inverse-relation rule (§4) and `count(1)` returning
a bare object against its own type — which is the main argument for keeping the spike around while
the real implementation is written.

`pnpm gates` on the repository still passes; `prototype/` is excluded from lint and the published
build.

## 9. Suggested implementation order

1. Type utilities (`ModelKey`, `CreateInput`, `Model`, `WhereUnique`, `RelationKey`, `Exact`) with
   type-level tests. This is the foundation and the riskiest part; land it first.
2. Resolution engine: context, per-field expansion, immutable builder.
3. `defineFactory` facade: definitions, states, count, overrides, make/create.
4. Sequences and hooks.
5. Relations: `with`, nested writes, the inverse-relation rule.
6. `recycle` and `identify`.
7. Decisions from §7.
