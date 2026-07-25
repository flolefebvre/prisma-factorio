# Relation wiring: sequential creates + `connect`, relation names from `_runtimeDataModel`

Factory relation features (`has`, `for`, parent-aware closures, `afterCreating`, `recycle`) assume created-then-continue semantics, so records are created sequentially rather than composed into one nested write. FK wiring always goes through Prisma relation operations (`connect`/nested input) — never raw FK columns, which the runtime datamodel does not even expose. The client's `_runtimeDataModel` (internal API, verified in Prisma 7.8 to be the only runtime source of relation metadata — the public `Prisma.dmmf` export no longer exists and no public method or callback carries the datamodel) is read from a single module, `src/datamodel.ts`, which owns every relation-metadata lookup: forward, from a pair of models to the relation field on the child, for `for` and for validating a relation field the caller named; and inverse, via the shared relation label, for `has`. A type cannot be read at runtime, so a relation field the caller leaves out has nowhere else to resolve from, and Prisma's own error for a mistyped relation key on a required relation names the field it finds missing rather than the bad key it was given. Confining the internal API to one module keeps a shift in Prisma's surface a one-file fix.

Relations are selected by relation field name, optional when the model pair has exactly one relation (enforced at the type level), required otherwise. An explicit inverse-name option remains as an escape hatch should the internal API shift within a Prisma major.

No implicit `$transaction` wraps a factory graph: matching Laravel, atomicity is the caller's concern via `.using(tx)`, which propagates into every parent factory a create resolves so that one call covers the whole graph. An implicit interactive transaction would impose timeouts on large seed graphs and would silently exclude queries made by user callbacks holding the outer client.

## Considered Options

- One nested-write `create` per graph — rejected: children are evaluated before the parent row exists, and nested writes do not return created child rows, breaking parent-aware closures, `afterCreating`, and return values.
- Parent-side `update` + nested create (no metadata needed) — rejected: created child rows are unrecoverable without re-query-and-diff.
- Requiring the inverse name on every `has` call — rejected as default DX; kept as the escape-hatch option.
