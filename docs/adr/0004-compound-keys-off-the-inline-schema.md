# Compound unique keys: read off the inline schema the client carries

A model whose only unique constraint is compound is matched on Prisma's generated selector — `{ a_b: { a, b } }` — which no flat splat of scalars satisfies. `_runtimeDataModel` marks nothing unique, and no query-surface probe answers this one: a selector's name surfaces only inside rendered error text, and its constituent fields nowhere at all once `name:` renames it. The client does carry the schema it was generated from, whole, as `_engineConfig.inlineSchema` — the client's own copy, so this is not the file-parsing ADR 0001 rejected. `src/datamodel.ts` scans that text for `@@id` and `@@unique` attributes, comment- and string-aware, and `targetWhere` adds a compound selector for every constraint a row can name whole, alongside the row's scalars.

The scan is conservative: anything it cannot read cleanly adds nothing, so a miss degrades to the flat splat that always was, never to an invented selector that refuses a connect which works today. A client carrying no inline schema — a hand-built double — degrades the same way rather than throwing. This is a second internal surface beside ADR 0002's `_runtimeDataModel`, deliberately, read from that same one module.

## Considered Options

- `Prisma.Args<…, 'findUnique'>['where']`, which does name the selector — rejected: type-level only, erased at runtime.
- Parsing the selector names out of a probe's validation-error message — rejected: message text is no contract, and it never yields the constituent fields.
- `@prisma/get-dmmf` over the same inline text — rejected: the library's first hard runtime dependency (~3 MB of WASM, eager at import), refusing a schema whole when any of its syntax outdates the pinned parser.
- An options-level `where` override, or documenting the limitation with the native-input workaround — superseded: the metadata is recoverable, so the fix is transparent.
