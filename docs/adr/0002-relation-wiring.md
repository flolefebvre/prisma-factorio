# Relation wiring: sequential creates + `connect`, relation names from `_runtimeDataModel`

Records are created sequentially — created-then-continue — never composed into one nested write: `has`, `for`, relation defaults, parent-aware closures, `afterCreating` and `recycle` all assume the row a step created exists and is returned. FK wiring always goes through Prisma relation operations (`connect`/nested input), never raw FK columns: raw columns are reachable only through Prisma's _unchecked_ create input, which drops the very relation fields the typed surface is built on.

Relation metadata is read off the client's `_runtimeDataModel` — an internal API, and the only runtime source of it in Prisma 7 — confined to `src/datamodel.ts` so a shift in Prisma's surface stays a one-file fix. ADR 0004 widens the read to a second internal surface, the inline schema, inside that same module. Relations are selected by relation field name, optional when the model pair shares exactly one; an explicit inverse-name option remains the escape hatch.

No implicit `$transaction` wraps a factory graph: atomicity is the caller's, via `.using(tx)`, which propagates to every factory the graph resolves.

## Considered Options

- One nested-write `create` per graph — rejected: children evaluate before the parent row exists, and nested writes return no created child rows.
- Parent-side `update` + nested create — rejected: created child rows are unrecoverable without re-query-and-diff.
- Requiring the inverse name on every `has` call — rejected as default DX; kept as the escape hatch.
