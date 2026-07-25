# prisma-factorio

Laravel-style model factories for Prisma: tests and seeds declare the records they need through a fluent, fully typed API inferred from the user's generated Prisma client.

## Language

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

**Recycle pool**:
Per-model lists of existing rows carried by a factory chain; anywhere the graph would create a record of a pooled model, it connects a pool row instead. Merged across `.recycle()` calls, propagated to the whole graph, never self-populating.
_Avoid_: cache, registry
