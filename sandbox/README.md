# sandbox

A working prototype of the API in `docs/design-proposal.md`, kept so the proposal's
claims can be re-checked rather than taken on trust. It is a design artifact, not a
candidate implementation.

```
pnpm sandbox:verify     # generate the client, migrate, typecheck, run tests
```

| Path                          | What it is                                                      |
| ----------------------------- | --------------------------------------------------------------- |
| `prisma/schema.prisma`        | a schema covering every relation shape the design has to handle |
| `lib/`                        | the prototype, laid out as the proposal's §6 suggests           |
| `spec/factories.ts`           | definitions written in the proposed API                         |
| `spec/usage.test.ts`          | behaviour against SQLite                                        |
| `spec/hard-relations.test.ts` | self relations, two relations between one pair of models        |
| `spec/metadata.test.ts`       | inverse resolution against a stubbed data model                 |
| `spec/*.check.ts`             | type-level tests — never run, `tsc` is the assertion            |

`generated/` and `prisma/*.db` are ignored; `pnpm sandbox:generate` recreates both.
