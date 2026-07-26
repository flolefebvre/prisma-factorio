# prisma-factorio

Laravel-style model factories for Prisma: tests and seeds declare the records they need through a fluent, fully typed API inferred from the user's generated Prisma client.

## Language

**Factorio**:
The client-bound entry point `initPrismaFactorio` hands back, carrying the one faker and the one recycle stream every factory it defines draws from. Bootstrapping is the act that produces it; the Factorio is the object produced.
_Avoid_: bootstrap (names the act), container, registry, root

**Factory**:
An immutable, fluent builder bound to one Prisma model that produces records from a definition plus applied transformations.
_Avoid_: builder, blueprint

**Definition**:
The function in a factory's config that returns the model's default attributes.
_Avoid_: defaults, template

**State**:
A named attribute transformation declared in the factory config; exposed as a typed method on the factory.
_Avoid_: trait, variant, scenario

**Create**:
Evaluate a factory and persist the record(s) through the Prisma client, returning the real database row(s).
_Avoid_: persist, insert

**Index**:
The 0-based position of a record within the current batch; resets every batch.
_Avoid_: position, i, sequence

**Uid**:
A short string unique across records and parallel test workers (random per-process prefix plus counter), provided as a value in evaluation contexts; one per record evaluation. Exists to satisfy unique constraints.
_Avoid_: uuid, globalIndex, seq

**Relation field**:
The named field on a model that points at another model (e.g. `posts` on `User`, `author` on `Post`). The name used to select a relation in the factory API.
_Avoid_: relation name, relationship

**Relation label**:
Prisma's `@relation("…")` pairing key (`relationName` in the runtime datamodel), shared by the two relation fields of one relation. Internal to the library; never appears in the API.
_Avoid_: relationName (in API surfaces)

**Parent**:
The record a factory attaches the records it creates to, named by `for()`, by a relation default, or by the `has()` call it hangs from. A child reads it as the created row through `StateContext.parent`.
_Avoid_: owner, target, related record

**Child**:
A record on the many side of a relation field, attached to one parent by `has()` or by a relation default — created per parent record by a factory of its own, or connected as an existing row.
_Avoid_: descendant, dependent, sub-record

**Relation default**:
A relation-valued attribute in a definition, a state or `create()` overrides, holding a factory, an existing row, native Prisma relation input, or — where the field holds many records — a list of rows. It sets the field rather than adding to it, and stands for children rather than for a parent wherever the field holds many records.
_Avoid_: nested factory, embedded relation

**Recycle pool**:
Per-model lists of existing rows carried by a factory chain; anywhere the graph would create a _related_ record of a pooled model, it connects one pool row per record it would have created — the records a factory itself creates are exempt, as is a slot the caller named outright through `for()` or overrides. Merged across `.recycle()` calls, propagated to the whole graph, never self-populating.
_Avoid_: cache, registry

**Callback**:
A side effect a factory carries, spelled `afterCreating` — declared in its config or added to the chain — belonging to each record the factory itself creates, and reaching it complete: the row as the database left it, its graph written, and the client the chain writes through. A row a recycle pool stood in with carries none, having been connected rather than created.
_Avoid_: hook, listener, observer, afterCreate
