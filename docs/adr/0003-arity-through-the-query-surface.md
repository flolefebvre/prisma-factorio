# Relation field arity: read through the query surface, not off client metadata

Nothing the client carries marks a relation field's arity, and guessing wrong is silent rather than loud: a factory forced into a field holding a single record creates a stray parent row instead of throwing. `holdsManyRecords` in `src/datamodel.ts` therefore asks Prisma's own validation — a `findFirst` under a relation filter only a field holding many records accepts — and reads the outcome structurally, on `error.name === "PrismaClientValidationError"`, never by parsing message text. The answer is memoized per client, model and field; a rejected probe is evicted rather than cached, a genuine database error is rethrown rather than read as an answer, and the probe fires lazily.

The cost: no query at all for a field holding a single record (Prisma refuses the filter client-side), one `SELECT … LIMIT 1` for a field holding many, once per client — a `.using(tx)` client probes once of its own. Two consequences follow: the library issues a read query against the caller's database, and `findFirst` is a required delegate capability wherever a relation default stands — the error names the missing method and what it is read for.

## Considered Options

- A metadata signal on the client — rejected: none exists in Prisma 7; `_runtimeDataModel` fields carry `name`, `kind`, `type`, `relationName` and nothing further.
- Parsing `client._engineConfig.inlineSchema`, which does carry arity — rejected here. ADR 0004 later adopts that surface for compound unique keys, which no probe can answer; the arity probe stands.
- A `$extends` query override as a zero-query oracle — rejected: it runs before Prisma validates arguments, so both arities reach it identically.
- Relation defaults barred from fields holding many records — rejected: breaks PRD #26's uniform attribute type.
