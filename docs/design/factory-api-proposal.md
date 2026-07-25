# Design proposal: Laravel-style factories for Prisma

Status: proposal, verified by prototype. Every behavioral and typing claim in
this document is exercised by the test suite in `sandbox/factorio.test.ts`,
which runs the prototype implementation (`sandbox/factorio.ts`) against a real
generated Prisma 7 client and a real sqlite database. See
[Reproducing the verification](#reproducing-the-verification).

The feature set being ported is documented in `docs/laravel-factories.md`.

## 1. What a user writes

```ts
// factories.ts — one module per project, or one per model
import { createFactorio } from "prisma-factorio";
import type { PrismaClient } from "./generated/client.ts";

export const factorio = createFactorio<PrismaClient>();

export const UserFactory = factorio.define("user", {
  definition: ({ faker, seq }) => ({
    email: `user-${seq}@example.com`,
    name: faker.person.fullName(),
  }),
  states: {
    suspended: () => ({ suspended: true }),
    withRole: (role: string) => ({ role }),
  },
});

export const PostFactory = factorio.define("post", {
  definition: ({ faker }) => ({
    title: faker.lorem.sentence(),
    author: UserFactory, // required belongs-to: a factory as default value
  }),
});
```

```ts
// test setup
factorio.use(prisma);

// usage — all fully typed, no casts, no generated helper code
const user = await UserFactory.suspended().create({ name: "Abigail" });
const users = await UserFactory.count(3).create();
const posts = await PostFactory.count(3).for("author", user).create();
const author = await UserFactory.has("posts", PostFactory.count(2)).create();
author.posts[0]; // typed: children created through has() are included
const data = UserFactory.make(); // resolved attributes, nothing persisted
```

## 2. Core design decisions

### D1. Zero codegen, zero private API

The library derives everything from the **generated Prisma client**: types at
the type level, behavior through the public client API. No extra generator
step, no schema parsing, no reliance on Prisma internals.

This is a real constraint, not a free choice. Investigation of the Prisma 7
client showed:

- The runtime data model embedded in the generated client
  (`_runtimeDataModel`) is minimal: field name, kind, type, relation name.
  **No primary keys, no unique constraints, no FK field mappings, no
  defaults.** The full schema text exists as `_engineConfig.inlineSchema`, but
  both are private, underscore-prefixed internals.
- The type level is far richer: `Prisma.Args`, `Prisma.Result` (public
  client-extension utilities) and the generated input types encode everything
  a factory API needs, including which fields are relations and whether they
  are to-one or to-many (see D5).

Alternatives considered and rejected:

- **Ship our own Prisma generator** (a `prisma-factorio` generator block that
  emits schema metadata). Strictly more powerful — it would give runtime
  access to PKs, uniques and FK mappings — but it adds an install step, a
  second artifact to keep in sync, and a whole generator protocol surface to
  maintain. Not needed for Laravel feature parity (D6/D7 conventions cover the
  gaps). Can be added later purely as an enhancement if a feature demands it.
- **Parse `inlineSchema` at runtime.** Depends on private API and requires a
  Prisma-schema parser; fragile across Prisma versions.

### D2. Relations are Prisma nested writes

Laravel's `has()`, `for()` and `hasAttached()` all map onto a single Prisma
concept: the factory composes a **create-input tree** and hands it to one
`client.model.create()` call. `has("posts", PostFactory.count(3))` becomes
`{ posts: { create: [...] } }`; `for("author", user)` becomes
`{ author: { connect: { id } } }`.

Consequences, all verified:

- A root `create()` with nested children is **one atomic Prisma call**.
- Children attached via `has()`/`for()` come back typed and loaded on the
  result, because the factory knows exactly which relations it attached and
  passes the matching `include` tree (Laravel does the same with
  `->has(...)->create()` returning loaded relations).
- **`hasAttached()` is not needed.** Prisma has no hidden pivot: an implicit
  many-to-many (`Post.tags`) takes `has("tags", TagFactory.count(3))`
  directly, and an explicit join model with pivot columns is just a factory
  for the join model:

  ```ts
  await TeamFactory.has(
    "memberships",
    MembershipFactory.count(2).asRole("owner"), // pivot attrs = states
  ).create();
  ```

### D3. Factories are keyed by client delegate name

`factorio.define("user", ...)` — the model identifier is the client property
name (`prisma.user`), not the schema model name (`User`). This avoids any
name-mangling logic (Prisma lowercases the first letter for delegates), gives
autocomplete on the `define` argument for free, and makes the runtime lookup a
plain `client[model]`.

### D4. Definitions must be complete create inputs

The `definition` return type is the model's create input, with one extension:
**a relation field may be given a factory as its value.** A required
belongs-to (e.g. `Post.author`) therefore _must_ appear in the definition —
omitting it is a compile error — and the idiomatic default is a factory:

```ts
definition: ({ faker }) => ({
  title: faker.lorem.sentence(),
  author: UserFactory,
});
```

This is Laravel's `'user_id' => User::factory()` pattern, but enforced
statically: you cannot define a factory that produces records which fail on
insert for a missing parent. `PostFactory.create()` with no arguments works
out of the box and auto-creates its author. Because the create-input type is
Prisma's own `XOR<CreateInput, UncheckedCreateInput>`, definitions may
equivalently use the unchecked style (`authorId: 1`).

### D5. Relation names and shapes are derived from create-input types

No metadata is needed to know a model's relations — the generated create
input already encodes them structurally:

- A field is a **relation** iff its (non-nullable) value type has a
  `connect` property (`RelationKeys`).
- A relation is **to-many** iff its `connect` accepts an array
  (`HasManyKeys`).

`has()` only accepts to-many relation names, `for()` any relation name, both
with autocomplete and typo rejection (verified with `@ts-expect-error`
tests).

### D6. Convention: existing records connect by `id`

`for("author", user)` with an already-persisted record must produce
`connect: { id: user.id }`. Prisma **strictly rejects** extra fields in
`connect` (verified: passing a full record throws a validation error), and
without runtime PK metadata (D1) the library cannot know the unique fields of
an arbitrary model. Resolution:

- If the record has an `id` property → `connect: { id }` (covers the
  overwhelmingly common convention).
- Escape hatch, fully typed against the model's `WhereUniqueInput`:
  `for("author", { connect: { email: "a@b.c" } })` — required for composite
  primary keys or `id`-less models.
- Anything else → a clear error at build time.

### D7. Convention: the inverse relation is stripped when nesting

When `MembershipFactory` (definition: `{ user: UserFactory, team:
TeamFactory }`) is nested under a team via `has("memberships", ...)`, the
nested create input is `MembershipCreateWithoutTeamInput` — Prisma rejects a
`team` key there. The library cannot ask the schema which field is the
inverse (D1), so it applies a convention: **when nesting under a parent,
definition-supplied factory values that target the parent's model are
dropped.**

Verified: `TeamFactory.has("memberships", MembershipFactory.count(2))`
creates one team, two memberships, two auto-created users, and no spurious
team.

Known limit: a child with _two_ relations to the same model (e.g.
`Message.sender` / `Message.recipient`, both `User`) would have both
stripped. The spec should include an explicit override (e.g.
`has("sentMessages", MessageFactory, { inverse: "sender" })`) for that case;
it is an additive extension.

### D8. `recycle()` is keyed by model name

Laravel infers the recycled model from the PHP object's class; a Prisma record
is a plain object, so the model is named explicitly:

```ts
const alice = await UserFactory.create();
const comment = await CommentFactory.recycle("user", alice).create();
// comment.author is alice AND comment.post.author is alice
```

During resolution, any nested factory whose model has a recycled pool emits
`connect` (to a random pool member, matching Laravel) instead of `create`.
The pool propagates through the whole nested tree — verified with the
Comment→Post→User diamond, which is Laravel's Ticket/Flight/Airline example.

### D9. Client binding is explicit and swappable

Factories are defined without a client. `factorio.use(prisma)` binds one
globally (test setup); `.using(otherClient)` overrides per chain, which is
what makes factories usable inside `prisma.$transaction(async (tx) => ...)`
and with per-test clients.

## 3. API reference

`createFactorio<PrismaClient>(options?)` → `{ define, use }`. All factory
methods are immutable — each call returns a new factory, so partially-applied
factories can be shared safely (same as Laravel).

| Member                          | Signature (conceptual)                                                        | Notes                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `define`                        | `define(model, { definition, states?, afterMaking?, afterCreating? })`        | `model` autocompletes to delegate names                                                                                                                                                |
| `use`                           | `use(client)`                                                                 | global bind, typically in test setup                                                                                                                                                   |
| `definition`                    | `(ctx: { faker, index, seq }) => CreateInputWithFactories`                    | `seq` is a per-model monotonic counter for unique values; `index` is the position in the current batch                                                                                 |
| `states` (config)               | `Record<name, (...args) => Partial<Attrs> \| (attrs, ctx) => Partial<Attrs>>` | each entry becomes a chainable method: `UserFactory.withRole("admin")`                                                                                                                 |
| `state`                         | `state(partial \| (attrs, ctx) => partial)`                                   | inline anonymous state                                                                                                                                                                 |
| `sequence`                      | `sequence(...values)`                                                         | sugar: state that cycles values by batch index (Laravel `Sequence`)                                                                                                                    |
| `count`                         | `count(n)`                                                                    | switches `create`/`make` to array results (typed)                                                                                                                                      |
| `has`                           | `has(relation, factory)`                                                      | to-many relation names only; child included on result                                                                                                                                  |
| `for`                           | `for(relation, factory \| record \| { connect })`                             | any relation; records connect per D6                                                                                                                                                   |
| `recycle`                       | `recycle(model, ...records)`                                                  | D8                                                                                                                                                                                     |
| `afterMaking` / `afterCreating` | `(record) => void \| Promise<void>`                                           | config-level and chainable; `afterCreating` receives the typed created record and runs for nested `has()`/`for()` children too (their created rows are available via the include tree) |
| `using`                         | `using(client)`                                                               | per-chain client override                                                                                                                                                              |
| `create`                        | `create(overrides?) => Promise<Model \| Model[]>`                             | overrides accept scalars and factories, applied after states                                                                                                                           |
| `make`                          | `make(overrides?) => Attrs \| Attrs[]`                                        | resolves attributes without persisting; see §5 for the deliberate difference from Laravel                                                                                              |

Result typing accumulates through the chain: `count()` flips a `Many` type
parameter; each `has()`/`for()` adds the relation to an `Inc` record, and the
result type is `Prisma.Result<Delegate, { include: Inc }, "create">` — so
`user.posts` exists (typed `Post[]`) exactly when `has("posts", ...)` was
called.

## 4. Laravel feature mapping

| Laravel                                         | prisma-factorio                                      | Status                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `definition()`                                  | `definition` config                                  | ✅ verified                                                                                                                               |
| Faker via `fake()`                              | `faker` in the definition/state context              | ✅ verified                                                                                                                               |
| State methods (`->suspended()`)                 | `states` config → generated chainable methods        | ✅ verified, typed through the whole chain                                                                                                |
| `state([...])` inline                           | `state(...)`                                         | ✅ verified                                                                                                                               |
| `Sequence` / `sequence()`                       | `sequence(...)`, closure form via `(attrs, ctx)`     | ✅ verified                                                                                                                               |
| `count(n)`                                      | `count(n)`                                           | ✅ verified, result typed as array                                                                                                        |
| `make()`                                        | `make()`                                             | ✅ verified (returns attrs, not a model — see §5)                                                                                         |
| `create(attrs)`                                 | `create(overrides)`                                  | ✅ verified                                                                                                                               |
| `afterMaking` / `afterCreating` / `configure()` | config-level + chainable hooks                       | ✅ verified incl. nested children                                                                                                         |
| `has(Post::factory()->count(3))`                | `has("posts", PostFactory.count(3))`                 | ✅ verified                                                                                                                               |
| `for(User::factory())` / `for($user)`           | `for("author", UserFactory)` / `for("author", user)` | ✅ verified                                                                                                                               |
| `'user_id' => User::factory()` in definition    | `author: UserFactory` in definition                  | ✅ verified, statically required                                                                                                          |
| `hasAttached(..., pivot)`                       | composition: `has()` + join-model factory (D2)       | ✅ verified; sugar could be added later                                                                                                   |
| `recycle($model)` / `recycle($collection)`      | `recycle("user", ...records)`                        | ✅ verified, deep                                                                                                                         |
| Magic methods (`hasPosts(3)`, `forUser()`)      | **dropped**                                          | relation names are typed and autocompleted; a `Proxy`-based emulation would add complexity for no DX gain over `has("posts", ...)`        |
| `trashed()` state                               | **dropped**                                          | Prisma has no built-in soft deletes                                                                                                       |
| Polymorphic relations                           | **out of scope**                                     | Prisma has no native polymorphic relations; whatever pattern the schema uses (nullable FKs, explicit models) works through the normal API |
| Model/factory discovery conventions             | **not applicable**                                   | no global namespace to scan; factories are plain exported values                                                                          |

## 5. Deliberate differences from Laravel

- **`make()` returns resolved attributes, not a model instance.** Prisma has
  no detached model objects; DB-generated values (autoincrement ids,
  `@default`s not set by the definition) do not exist before insert and the
  library will not fake them. `make()` is therefore "the data that _would_ be
  sent", typed as the scalar part of the create input. This also covers
  Laravel's `raw()`.
- **Definitions are statically complete** (D4). Laravel discovers missing
  attributes at insert time; here the type checker does.
- **No global factory registry.** Laravel resolves factories by naming
  convention; here factories are ordinary values you import. This removes the
  discovery magic and is what makes everything typecheck.

## 6. Typing architecture (for the implementer)

All schema knowledge comes from four small derived types over the client type
`C` and delegate key `K` (prototype: `sandbox/factorio.ts`, top section):

- `ModelKey<C>` — string keys of `C` whose value has a `create` method.
- `CreateData<C, K>` — `Prisma.Args<C[K], "create">` `data` field.
- `CreateResult<C, K, Inc>` — `Prisma.Result<C[K], { include: Inc },
"create">` (default result when `Inc` is empty).
- `RelationKeys` / `HasManyKeys` / `ConnectInput` — structural extraction
  from `CreateData` (D5).

The public factory type is:

```ts
type FactoryApi<C, K, Inc, Many, S> = FactoryCore<C, K, Inc, Many, S> & StateMethods<C, K, Inc, Many, S>;
```

where `FactoryCore` is an interface declaring the built-in methods and
`StateMethods` is a mapped type turning each entry of the user's `states`
config into a chainable method.

Two hard-won constraints the implementation **must** respect:

1. **The circular-reference trap (TS2456).** `FactoryApi` cannot be written
   as `SomeShape & StateMethods<FactoryApi<...>, S>` — a type alias may not
   pass itself as a top-level type argument. TypeScript then treats the alias
   as an error type, and everything downstream silently degrades (methods
   still resolve, but results become `never`/`any` in subtle ways —
   `tsc` reports it only once, at the alias). The self-reference must sit in
   _deferred_ positions: interface member returns (`FactoryCore`) and
   mapped-type property values (`StateMethods` parameterized by
   `C, K, Inc, Many, S` rather than by the alias itself). The prototype
   structure is known-good; keep it.
2. **Methods that change type parameters can't rely on `this` typing.**
   `count()` and `has()` return a _different_ instantiation of the factory
   type, so polymorphic `this` cannot carry the named-state methods through
   the chain — which is exactly why `S` must be a type parameter and the
   named states must be re-attached (in types via `StateMethods`, at runtime
   by copying methods in the constructor/clone).

The implementation behind the interface is deliberately loose (`FactoryImpl`
with `Record<string, unknown>` data and internal casts): the create-input
tree it assembles is not expressible precisely without fighting Prisma's
`XOR` types, and correctness is enforced at the API boundary plus the
behavioral test suite. This is a conscious trade: strictness for users,
pragmatism inside.

## 7. Runtime architecture

A factory is an immutable `Spec`:

```
{ model, definition, layers[], relations[], count?, hooks, client?, recycled, states }
```

`create()` / `make()` resolution pipeline (per record in the batch):

1. `definition(ctx)` → base attributes (`ctx` = faker + batch `index` +
   per-model `seq`).
2. Apply state `layers` in order (named states, `state()`, `sequence()`);
   later wins; each layer sees the attributes so far.
3. If nested under a parent: strip inverse-relation factories (D7).
4. Materialize `relations[]` from `has()`/`for()` into nested
   `{ create }` / `{ connect }` inputs (recursing into child factories with
   the same resolve context, so `recycle` pools and faker flow down).
5. Convert remaining factory-valued definition fields the same way
   (recycle-aware, D8).
6. Apply `overrides` (factories allowed, same conversion).
7. `create`: one `client[model].create({ data, include })` where `include`
   mirrors the `has()`/`for()` tree — then run `afterCreating` hooks
   root-first, walking the included children. `make`: return the data and run
   `afterMaking`.

Notes for the spec:

- `count(n).create()` issues `n` separate `create` calls (nested writes and
  `createMany` are mutually exclusive in Prisma). Each root create is atomic;
  the batch as a whole is not. Wrapping the batch in a transaction (or using
  `createMany` when a factory has no relations) is a listed optimization.
- Prisma 7 rejects explicitly-`undefined` argument keys; the builder must
  omit absent keys (e.g. `include`) rather than pass `undefined`.
- Definition-inline factories (D4) are _not_ added to the `include` tree —
  only explicit `has()`/`for()` relations are. So hooks of inline-created
  parents do not run, and those parents are not on the returned record. This
  matches Laravel (definition-level `User::factory()` doesn't load the
  relation either) and keeps `include` under the user's control.

## 8. Environment facts (Prisma 7) the spec must assume

Verified in this repo with `prisma@7.8.0`:

- The only generator is `prisma-client` (TS-emitting); output is
  ESM `.ts` files imported directly from user code.
- Connection URLs live in `prisma.config.ts` (`datasource.url`), not in the
  schema; clients are constructed with a driver adapter
  (`@prisma/adapter-better-sqlite3` for the tests).
- `@faker-js/faker` should be a peer dependency (the definition context hands
  it to users; `createFactorio({ faker })` accepts a configured/seeded
  instance for locale and reproducibility).
- The library's own peer range `prisma >=7 <8` already matches all of this.

## 9. Open questions for the spec phase

Recommendations included; none block the core.

1. **Model-correlated factory arguments.** `has("posts", UserFactory)`
   currently compiles — any factory is accepted where a factory is expected
   (`AnyFactory`). Constraining the target factory's data type against the
   relation's nested create input is a typing-only, additive hardening; the
   spec should include it as a stretch goal with the caveat that Prisma's
   `XOR` input types make it fiddly.
2. **Explicit inverse override** for the D7 heuristic (two relations to the
   same model). Additive.
3. **Batch atomicity / performance**: optional `createMany` fast path and/or
   transaction-wrapped batches (§7).
4. **`seq` counters are global per model** (module state). Fine for tests
   run per-process; the spec should state whether a reset hook is offered
   (e.g. for watch-mode determinism).
5. **Async `afterMaking`** is accepted but not awaited by the synchronous
   `make()`. Either make `make()` async or restrict the hook to sync — the
   prototype currently fires-and-forgets, which is the worst option.
6. **`for()` chained on the child vs. parent naming**: `for()` on a root
   factory connects/creates its parent — but a `for()` the user adds to a
   _nested_ child targeting the parent model will collide with the nested
   position (Prisma rejects the inverse key, D7 strips only
   definition-supplied factories). The spec should define the error message.
7. **Where does `factorio` live in user projects** — one shared
   `createFactorio` instance is required for `use()` to reach all factories;
   the docs should prescribe the "one factories module" layout (§1).

## 10. Proposed package layout

```
src/
  index.ts          createFactorio, public types (FactoryApi, DefinitionCtx, ...)
  factory.ts        FactoryImpl + Spec (runtime engine)
  types.ts          ModelKey, CreateData, CreateResult, RelationKeys, ...
  tests/            shared helpers: test schema, generated client, db setup
```

The library has **no runtime dependency on Prisma** — it only ever touches
the client object handed to it — so `prisma`/`@prisma/client` stay peer/dev
dependencies, plus `@faker-js/faker` as a peer. Tests follow the sandbox
pattern: a representative schema (belongs-to, has-many, two-FKs-to-one-model,
implicit m:n, explicit join model with composite PK), `prisma db push` into
sqlite via driver adapter, and behavioral + `expectTypeOf`/`@ts-expect-error`
type tests in the same suite.

## Reproducing the verification

```sh
pnpm install
npx prisma generate --schema sandbox/prisma/schema.prisma   # client → sandbox/generated (gitignored)
npx prisma db push --config sandbox/prisma.config.ts        # creates sandbox/dev.db
npx tsc -p sandbox --noEmit                                 # typing claims
npx vitest run --config sandbox/vitest.config.ts            # behavioral claims (15 tests)
npx tsx sandbox/experiments/runtime-probe.ts                # D1/D6 probes
```

`sandbox/` is throwaway design collateral, excluded from the package build;
it should be deleted (or promoted into `src/` + `src/tests/`) when
implementation starts.
