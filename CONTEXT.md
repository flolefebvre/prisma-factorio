# prisma-factorio

A Laravel-style model factory library for Prisma (TypeScript), built as a custom Prisma generator. It lets tests and seeds declare the records they need through a fluent, fully typed API instead of hand-writing every column.

## Language

**Factory**:
The per-model entry point that produces data for that model, following a definition plus any applied states and overrides.
_Avoid_: builder, fixture, seeder

**Definition**:
The mandatory default attribute set a factory starts from, written in the factory class's `definition()` method. It must cover every required field of the model; TypeScript enforces this coverage at compile time. There is no auto-fill: leaving a required field out is a deliberate compile error, not a fallback.
_Avoid_: defaults, blueprint, auto-fill

**Callback**:
An `afterMaking` (sync, on the built `CreateInput`) or `afterCreating` (async, on the persisted row) hook, declared via `configure()` or chained on a state. A callback fires for every row its factory gave birth to — anywhere in the factory tree — and never for connected existing rows.
_Avoid_: hook, listener

**count()**:
Sets how many instances a factory produces and flips its result type to a list (`create()` → `Model[]`, `make()` → `CreateInput[]`). Count says how many; it is never implied by a sequence.

**sequence()**:
A cyclic state applied per instance index — either a list of override objects cycled over, or a closure receiving the 0-based index. Says what varies; never how many.
_Avoid_: rotate, alternate

**Factory-as-value**:
Using a factory instance as the value of a relation field inside a definition (e.g. `author: UserFactory.new()`), or its lazy form `() => UserFactory.new()` to break import cycles. It resolves lazily to a nested create in the `CreateInput`; if the caller supplies the relation, the nested factory is never evaluated.
_Avoid_: sub-factory, relation default

**recycle()**:
A transversal factory method that reuses the given existing instance(s) for every relation to that model anywhere in the factory tree (`recycle({ airline: myAirline })` → connect instead of nested create). Keys are model names because a plain object's model cannot be guessed at runtime; an array value means a random pick per use.
_Avoid_: share, reuse

**State**:
A chainable, immutable transformation of a factory's attributes, built on the `state()` primitive — as a named factory method (`suspended()`), inline at the call site (`.state({...})`), or as the final overrides argument of `make()`/`create()`. Accepts a partial object or a closure receiving the attributes evaluated so far (plus the parent's evaluated `CreateInput` for nested children). Applied in chain order with shallow, last-wins merging.
_Avoid_: trait, variant, preset

**Magic relationship method**:
A generated, fully typed per-relation method on a factory, named after the relation field in the Prisma schema. Three families: `hasX`/`forX` build the relation, `withX` only loads it into the typed return of `create()`. These are the only relationship API — there is no generic `has()`/`for()`/`with()`.
_Avoid_: relation helper

**make()**:
Builds the `CreateInput` payload for a model — the exact data one would pass to `prisma.<model>.create` — without touching the database. Synchronous.
_Avoid_: build, raw

**create()**:
Persists one or more records through the Prisma client and returns the persisted model(s). Asynchronous.
_Avoid_: save, insert, seed
