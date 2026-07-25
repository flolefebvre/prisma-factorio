# Design proposal: prisma-factorio

Laravel-style model factories for Prisma, fully typed, with no code generation.
Every claim in this document marked **verified** is backed by the working
prototype in `sandbox/` (28 passing tests, strict typecheck) built against
Prisma 7.8 with the `prisma-client` generator and the better-sqlite3 driver
adapter.

```ts
const user = await UserFactory.admin().has("posts", PostFactory.count(3).published()).create({ name: "Abigail" });
```

## 1. Goals and non-goals

Goals:

- Port the Laravel factory feature set (`docs/laravel-factories.md`) to
  idiomatic TypeScript: definitions, states, callbacks, `make`/`create`,
  `count`, sequences, `has`/`for` relationships, recycling.
- Full type safety derived from the user's Prisma client: attribute overrides,
  state payloads, relation names, and return types are all checked and
  autocompleted, with zero codegen and zero schema files read at runtime.
- Work inside interactive transactions so tests can roll back everything.

Non-goals (Laravel features that do not map to Prisma):

- Polymorphic relations (`morphTo`, `morphMany`) — Prisma has no native
  polymorphism.
- `trashed()` — soft deletes are not a Prisma concept.
- Factory discovery conventions (`HasFactory`, `guessFactoryNamesUsing`) —
  there are no model classes to attach factories to; factories are plain
  exported values that users import.
- Magic relationship methods (`hasPosts(3)`, `forUser()`) — PHP needed them
  because strings were untyped; `has("posts", …)` is equally terse in TS and
  the relation name is type-checked and autocompleted. (Technically feasible
  via template-literal mapped types plus a Proxy, but it breaks
  go-to-definition and adds nothing over the typed string.)

## 2. The one big architectural bet: no codegen

Alternatives considered for getting model knowledge:

| Approach                                                             | Used by                   | Verdict                                                             |
| -------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| Generator plugin emitting per-model factories                        | `@quramy/prisma-fabbrica` | Rejected: extra build step, generated API drifts from schema, heavy |
| Parse `schema.prisma` at runtime                                     | —                         | Rejected: fragile, duplicate source of truth                        |
| Parse `client._engineConfig.inlineSchema`                            | —                         | Rejected: undocumented internal, string parsing                     |
| **Types from delegate generics + runtime datamodel from the client** | this design               | **Verified**: everything needed is derivable                        |

Two pillars, both **verified**:

1. **Type level.** `Types.Public.Args<Delegate, "create">["data"]` and
   `Types.Public.Result<Delegate, {}, "create">` from
   `@prisma/client/runtime/client` resolve create inputs and result records
   for any delegate generically — the same mechanism Prisma documents for
   `$allModels` client extensions. The library imports these **types only**
   (`import type`), so it has _zero runtime dependency on Prisma_; the import
   is erased at build time. Packaging consequence: `@prisma/client >=7 <8`
   should be a peer dependency (types must resolve in the user's project — it
   is always present there anyway), and nothing from Prisma is bundled.
2. **Runtime level.** Prisma 7 removed `Prisma.dmmf`, but every client
   instance carries `client._runtimeDataModel.models`. **Finding: in Prisma 7
   this structure is stripped** — each field only has `name`, `kind`
   (`scalar`/`object`/`enum`), `type`, and `relationName`. There is **no
   primary-key, unique, default, or FK metadata**. The design below needs
   only what survives: which fields are relations, what model they point to,
   and relation pairing via `relationName` (used to find the inverse field of
   a relation). Verified sufficient for the whole feature set.

## 3. Public API

### 3.1 Defining a factory

```ts
import { defineFactory } from "prisma-factorio";
import { prisma } from "./client";

export const UserFactory = defineFactory(prisma, "user", {
  definition: ({ seq }) => ({
    email: `user-${seq}@example.test`,
    name: `User ${seq}`,
  }),
  states: {
    admin: () => ({ role: "ADMIN" }),
    named: (_ctx, name: string) => ({ name }),
  },
});

export const PostFactory = defineFactory(prisma, "post", {
  definition: ({ seq }) => ({
    title: `Post ${seq}`,
    author: UserFactory, // relation default: created (or recycled) on demand
  }),
  states: { published: () => ({ published: true }) },
});
```

Signature: `defineFactory(client, modelKey, config)`.

- `client` is captured at define time. `modelKey` is the client property
  (`"user"`), typed as `ModelKey<C>` (keys whose value exposes `create`), so
  it is autocompleted and validated. The string does triple duty: delegate
  lookup, runtime-datamodel lookup (uncapitalize of the datamodel model name —
  deterministic in both directions), and identity for `recycle` pools.
  Binding to the key rather than the delegate (`prisma.user`) is what lets
  `using(tx)` rebind an entire composition to another client later.
- `definition` must satisfy the model's create input (required fields without
  defaults are enforced by the compiler; fields with `@default` are optional).
  Three value kinds per attribute, all **verified**:
  - a plain value;
  - another **factory** on a relation field (Laravel's
    `'user_id' => User::factory()`): resolved at build time by recycling or
    creating the related record;
  - a **lazy closure** `(attrs) => value` (Laravel's closure attributes),
    resolved after everything else against the final attribute set.
- `definition` receives `{ seq }`, a monotonically increasing counter shared
  by every derived copy of the factory — the idiomatic way to build unique
  values. The library is **faker-agnostic**: users who want fake data import
  `@faker-js/faker` themselves inside `definition`. (Laravel bundles Faker
  because PHP has global helpers and locale config; in TS an explicit import
  is more idiomatic and keeps the dependency graph clean. If seeding
  reproducibility demands an injected, seeded faker later, `defineFactory`
  config can grow a `context` hook without breaking anything.)
- `states` become **chainable methods with their parameter types preserved**
  (`UserFactory.named("Bob").admin()`) — verified, including inference of
  extra state parameters via a mapped type over the states object.
  Two implementation notes that cost real debugging time, for the spec:
  - The config property must be declared `states?: S & StatesConfig<C[K]>`;
    with plain `states?: S` TypeScript will not contextually type the state
    functions' `ctx` parameter and users get `noImplicitAny` errors.
  - State names are attached as methods on the factory object at
    construction; a state named like a core method (`state`, `count`, …)
    throws at define time.

### 3.2 Building records

| Method                                  | Semantics                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `create(overrides?)`                    | Persist and return the record (array when `count(n)` is set)                                                                         |
| `make(overrides?)`                      | **Pure**: compile the factory chain into `create`-input data, no queries                                                             |
| `createMany(overrides?)`                | Batch insert via Prisma `createMany`, returns the inserted count; scalars only, no relation factories, no per-record `afterCreating` |
| `count(n)`                              | Switch `create`/`make`/`createMany` to n records; return types become arrays (tracked by a type-level flag)                          |
| `state(patch)`                          | Inline state: partial attributes or `(ctx) => partial` closure; `ctx.attrs` is the current attribute set                             |
| `sequence(...patches)`                  | Rotating per-record state applied by record index (Laravel `Sequence`)                                                               |
| `afterMaking(fn)` / `afterCreating(fn)` | Callbacks; also settable in `defineFactory` config (Laravel's `configure()`)                                                         |
| `using(client)`                         | Rebind execution to another client (typically an interactive-transaction client)                                                     |

All chain methods are **immutable** — each returns a new factory (Laravel
behaves the same way); a factory can be safely shared and forked. Attribute
merge order, first to last: `definition` → states/`state()` in call order →
`sequence()` by index → `create`/`make` overrides → parent-context override
(the connect forced by an enclosing `has`) → lazy closures resolved last.

`make()` deviates from Laravel deliberately: Laravel returns unsaved Eloquent
model instances, but Prisma has no model objects. Instead `make()` returns the
exact `data` object `create` would need — related factories become nested
`{ create: … }` blocks (with the inverse relation field stripped), existing
records become `{ connect: … }`. **Verified**: the output of `make()` feeds
directly into `prisma.post.create({ data })` and is typed as the model's
create input, so it composes with raw Prisma code, `$transaction` batches, and
assertions on pure logic.

`create()` return type is the plain model record (`Types.Public.Result`).
It does not include children created via `has` — Prisma records have no lazy
loading; users query with `include` when they need the graph back. (A future
`createWithRelations` returning an include-typed payload is possible; out of
scope for v1.)

### 3.3 Relationships

```ts
// has-many / has-one: children created after the parent, wired to it
await UserFactory.has("posts", PostFactory.count(3)).create();
await UserFactory.has("profile", ProfileFactory).create();

// belongs-to: parent resolved before this record
await PostFactory.for("author", UserFactory.admin()).create(); // create parent
await PostFactory.for("author", existingUser).create(); // connect existing

// attach existing records to a many relation
await PostFactory.has("tags", existingTags).create();

// implicit many-to-many
await PostFactory.has("tags", TagFactory.count(2)).create();

// explicit many-to-many with pivot data: go through the join-model factory
await UserFactory.has("teams", MembershipFactory.count(2).state({ role: "owner" })).create();

// reuse one related record across the whole composition
await PostFactory.count(3).recycle("user", pooledUser).create();
```

All **verified**, including: children's own definition-parent is overridden by
the enclosing parent (`has("posts", …)` creates exactly one user, not four);
child state closures receive the created parent via `ctx.parent` (Laravel's
closure-based state on related factories); child `afterCreating` hooks run per
child; explicit m-n creates the join rows with pivot state plus one team per
membership.

Design choices behind this surface:

- **Relation names are explicit strings, always** — but typed. `has` accepts
  any relation key of the create input; `for` accepts to-one relation keys.
  Laravel infers names from factory class names and offers magic methods; we
  get better ergonomics from autocompleted, compiler-checked strings.
- **`hasAttached` does not exist.** Implicit m-n needs no pivot, so `has`
  covers it. Explicit m-n (the only place Prisma has pivot columns) is just a
  has-many to the join model, so the join-model factory pattern above is the
  documented mapping.
- **`recycle(modelKey, records)` names the model explicitly** (Laravel infers
  it from the PHP class of the passed instance; Prisma records are plain
  objects, so structural inference is impossible). Records are typed against
  the named model. Pools are consulted whenever a _factory_ would create that
  model (definition refs and `for` factories); explicitly passed records
  always win. Pool picks are **round-robin**, deviating from Laravel's random
  pick, so tests stay deterministic.

### 3.4 Execution model: interpreter, not nested writes

`create()` walks the composition and issues **one `create` per record**, in
dependency order: `for`-parents and definition-factory parents first (recycled
or created, then `connect`ed), then the record itself, then `has`-children
(each child created through its own factory with a forced `connect` to the
parent), then `afterCreating` hooks — children before the parent's own hooks,
matching Laravel.

The alternative — compiling the whole tree into a single nested-write query —
was rejected for `create()` because it cannot express per-child sequences
consulting the database, parent-dependent state closures, or per-child
`afterCreating` hooks with real records. The pure nested-write compilation
exists anyway: it is exactly what `make()` produces, and a future optimization
may use it as a fast path when a composition has no hooks or closures.

`using(txClient)` rebinds the _whole_ composition — child factories execute
against the caller's client, not the one they were defined with, because the
execution context (client + recycle pools + parent record) flows down the
tree. **Verified**: a `$transaction` callback that creates a user with posts
and then throws leaves the database empty. The runtime datamodel is always
read from the define-time client, so a transaction client never needs to
expose internals.

### 3.5 Connecting records: the all-scalars strategy

Prisma's `connect` needs a `WhereUniqueInput`, and the stripped runtime
datamodel does not say which field is the primary key. **Finding**: since
extended where-unique (Prisma 5+), non-unique scalars are accepted alongside
unique ones as filters. So the library connects with **every scalar field of
the record** (relation fields stripped via the runtime datamodel). The PK is
necessarily among them, and the extra fields are equality filters that always
match. **Verified** end-to-end, including `DateTime` equality round-trips
through better-sqlite3.

**Known limitation (verified to fail)**: models whose only unique identifier
is a _composite_ key (`@@id([a, b])`) reject flat scalar filters — Prisma
requires the synthesized composite field (`a_b: { a, b }`), whose name is not
in the runtime datamodel. Both the type checker and the runtime reject the
flat form. Spec answer: a per-factory `connectOn: (record) => whereUnique`
config escape hatch, typed against the model's where-unique input. In practice
composite-id models are join models, which get _created_, not connected, so
the default covers the common paths.

## 4. Laravel feature mapping

| Laravel                                            | prisma-factorio                                             | Status   |
| -------------------------------------------------- | ----------------------------------------------------------- | -------- |
| `definition()`                                     | `definition` config with `{ seq }` context                  | verified |
| `fake()` helper                                    | user-imported faker (library is faker-agnostic)             | decided  |
| State methods calling `$this->state()`             | `states` config → typed chainable methods, `state()` inline | verified |
| State closures receiving raw attributes            | `state(({ attrs }) => …)`                                   | verified |
| `configure()` + `afterMaking/afterCreating`        | config hooks + chainable hook methods                       | verified |
| `make()` / `create()` / `count()`                  | same names; `make` returns create-input data                | verified |
| Overrides to `make`/`create`                       | same, type-checked against the create input                 | verified |
| `Sequence` / `sequence()`                          | `sequence(...patches)` + `seq` counter in definition        | verified |
| `has(Factory, 'name')`                             | `has('name', factory \| records)`                           | verified |
| `for(Factory \| $model)`                           | `for('name', factory \| record)`                            | verified |
| Related-factory state closure with parent          | child `state(({ parent }) => …)`                            | verified |
| `hasAttached` + pivot attributes                   | join-model factory pattern (explicit m-n)                   | verified |
| `'user_id' => User::factory()` in definition       | `author: UserFactory` (relation field, not FK)              | verified |
| Closure attributes depending on others             | lazy closures `(attrs) => …`                                | verified |
| `recycle($model \| collection)`                    | `recycle('model', record \| records)`, round-robin          | verified |
| Magic methods, `trashed()`, polymorphic, discovery | dropped (see non-goals)                                     | decided  |

## 5. Type-level findings the spec must preserve

1. **`Args`/`Result` generics work from the library side** against the Prisma 7
   `prisma-client` generator output, keyed only by delegate types — the public
   extension mechanism, unlikely to break within `>=7 <8`.
2. **Relation-key classification is derived structurally** from the create
   input: a field is a relation iff its value type has a `connect` key and no
   index signature (the index-signature guard keeps `Json` columns out);
   to-many iff `connect` accepts an array.
3. **The checked/unchecked XOR union blocks owning-side detection.** The ideal
   typing (`for` = only FK-owning relations) needs to know, per member of
   `XOR<CreateInput, UncheckedCreateInput>`, whether the key survives —
   distributing mapped types over that union collapses (member indexing
   degrades to `any`; reproduced and abandoned). Hence: `has` = all relation
   keys, `for` = to-one keys. Both reject scalars and `for` rejects to-many —
   strictly better than Laravel's untyped strings; revisit only if TS behavior
   changes.
4. **`Partial<Data>` overrides behave well** including excess-property errors
   on literals (`create({ nope: 1 })` fails to compile).
5. **What is not type-checked (runtime-checked instead):** that the factory
   passed to `has`/`for`/a definition ref actually builds the relation's
   target model. The relation's target model type is not recoverable from the
   create input alone. The runtime datamodel check throws a descriptive error
   at build time. `ctx.parent` in state closures is `unknown` for the same
   reason.
6. The result type of `create` uses `Result<Delegate, {}, "create">`; test
   assertions confirmed exact scalar types (`string`, `Date`, …) flow through.

## 6. Suggested source layout for the implementation

The prototype is a single file for reviewability; the real implementation
should split roughly into:

```
src/
  index.ts          defineFactory + public types (Factory, config, contexts)
  types.ts          CreateData/ModelRecord/ModelKey/relation-key machinery
  factory.ts        immutable FactoryImpl (chain methods, derive())
  resolve.ts        attribute resolution: definition, patches, sequences, lazy pass
  execute.ts        create interpreter: parents, connect, children, hooks
  compile.ts        make(): pure nested-write compilation
  datamodel.ts      runtime-datamodel access: model lookup, inverse relation, scalars-of
```

with the TDD suite mirroring the sandbox test matrix against a checked-in test
schema (SQLite + better-sqlite3 adapter, `pnpm sandbox:prepare`-style setup as
a pretest step or global fixture).

Suggested implementation slices (each is a vertical, testable increment):

1. `defineFactory` + `definition` + `create`/`make` + overrides (no relations)
2. states (named, parameterized, inline) + `sequence` + `count`
3. definition factory refs + `for` + connect-by-scalars + recycle
4. `has` (factories and records) + parent context + inverse-relation forcing
5. hooks (`afterMaking`/`afterCreating`), `createMany`, `using`
6. hardening: error messages, `connectOn`, Json/bytes edge cases

## 7. Open questions deferred to the spec phase

- `connectOn` exact shape (config key vs per-call), and whether `for`/`has`
  with an existing _record_ should also accept an explicit where-unique.
- Should `create()` optionally wrap the whole composition in `$transaction`
  (`createInTransaction()`? config flag?) — the prototype leaves transaction
  control to the caller via `using`.
- `createManyAndReturn` as a richer batch path where supported.
- Whether `seq` should be resettable (`Factory.resetSequences()` for suite
  isolation) — Laravel has no equivalent; tests using unique constraints may
  want it.
- npm name (`prisma-factorio` is taken as a Factorio-mod term nowhere, but
  check registry availability before publishing).

## 8. The prototype

`sandbox/` is throwaway verification code, excluded from the root gates (own
tsconfig; eslint/jscpd ignore it). Layout:

| File               | Role                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `schema.prisma`    | Test schema: 1-n, 1-1, implicit m-n, explicit m-n join with composite `@@id`, defaults, uniques |
| `prisma.config.ts` | Prisma 7 config (datasource URL for `db push`)                                                  |
| `factorio.ts`      | The prototype library — the design in executable form                                           |
| `factories.ts`     | Example factory definitions (the DX target)                                                     |
| `factorio.test.ts` | 28 tests: the verification matrix for every claim above                                         |

Run it:

```
pnpm sandbox:prepare   # prisma generate + db push (generated/ and dev.db are gitignored)
pnpm sandbox:verify    # strict typecheck + test suite
```
