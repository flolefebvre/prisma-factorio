# Design-verification sandbox

Throwaway collateral for `docs/design/factory-api-proposal.md`: a prototype
of the proposed factory API (`factorio.ts`), example factory definitions
(`factories.ts`), and a test suite (`factorio.test.ts`) that verifies every
claim the proposal makes against a real generated Prisma 7 client and a real
sqlite database.

Not part of the published package, not covered by the root `pnpm gates` test
run. See the proposal's "Reproducing the verification" section for setup and
commands (`prisma generate` + `db push` are required first — the generated
client and the database file are gitignored).
