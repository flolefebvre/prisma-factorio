# Fresh rows as foreign keys: the unchecked input where every key is fresh, `connect` everywhere else

Prisma 7 runs a create carrying a nested `connect` as an implicit transaction of its own, with an existence read. Against Postgres that costs about 1.3 ms per row: ten posts take about 44 ms with `author: { connect: { id } }` and about 11 ms with `authorId` written directly. Every factory-built row with a parent paid it. So a row the build created a moment ago — for a relation default, for a `for(factory)` parent, or as the parent a `has` child reaches back to — is now written as the foreign key it stands for. This supersedes ADR 0002's "never raw FK columns" for those rows. A row that fresh cannot have gone stale, so matching it on every scalar gains nothing.

Prisma's create `data` is either the checked input, where relation fields carry the keys, or the unchecked input, where raw columns carry them. A column beside a `connect` on another key-holding relation fits neither, and Prisma refuses it. Relation fields that hold no key fit both: to-many, many-to-many, and the inverse side of a one-to-one. So a create switches to columns only when every key-holding relation it writes is filled by a fresh row. Otherwise the whole create stays on `connect`. That also applies when a column the key would fill is already in the data.

Rows the caller hands over and rows a recycle pool draws keep the full non-null-scalar `connect`. A test helper that empties tables and rewinds sequences hands ids 1, 2, 3… to new rows in every test. A stale row matched on its id alone would silently reach an unrelated record, while one matched on every scalar fails with `P2025`. A `null` is left out of that match, because Prisma refuses one under a nullable unique column (#63).

The key's `fields` and `references` come from the `@relation` attribute on the side holding it. They are read by the same comment- and string-aware scan of `_engineConfig.inlineSchema` that ADR 0004 introduced, in `src/datamodel.ts`. The scan is conservative in the same way. A declaration it cannot read cleanly, a key naming a field the runtime datamodel does not declare, or a client carrying no inline schema leaves the create on `connect`, which is the behaviour that always was.

## Considered Options

- Narrowing every `connect` to the id — rejected: a pooled or caller row that went stale would reach a new record under a reused id without a sound.
- Columns for fresh rows and `connect` for the rest in one create — rejected: Prisma refuses the mix.
- A generator emitting the key metadata — rejected by ADR 0001.
- Batching `has` children through `createMany` — deferred: it would give up the rows every child hands back.
