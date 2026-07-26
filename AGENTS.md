# prisma-factorio

## Context

This project is a Laravel-style model factory library for Prisma (TypeScript). Tests and seeds declare the records they need through a fluent, fully typed API instead of hand-writing every column.

`docs/laravel-factories.md` documents the Laravel original whose feature set is being ported. The design is settled: PRD #26 on the issue tracker defines v1 scope and its deliberate deviations from Laravel; `docs/adr/` records the binding architecture decisions; `CONTEXT.md` fixes the vocabulary. Do not re-open settled decisions inside an implementation task — flag conflicts instead (see `docs/agents/domain.md`).

## Stack

TypeScript (strict, ESM) · Node ≥ 20 · @prisma/client ≥ 7 < 8 as required peer · prisma ≥ 7 < 8 and @faker-js/faker as optional peers · Vitest · ESLint + Prettier + jscpd. Package manager: pnpm.

## Layout

```
CONTEXT.md        Domain glossary
prisma.config.ts  Prisma CLI configuration (required by Prisma 7)
prisma/
  schema.prisma   Scratch schema for this library's own tests
src/
  index.ts        Package root export
  datamodel.ts    Relation metadata off the client; the only reader of `_runtimeDataModel`
  tests/          Shared test helpers (never published)
    generated/    Generated scratch client and its DDL (gitignored, never published)
scripts/
  check-pack.ts   Asserts what `npm publish` would ship; the last gate
.github/
  workflows/      CI on every push and pull request, release on a `v*` tag
docs/
  adr/            Architectural decision records
  agents/         Agent workflow docs (issue tracker, labels, domain)
  releasing.md    How a version reaches npm, and the one-time npm setup
  laravel-factories.md   Laravel factories docs (original reference)
```

## Commands

All via pnpm.

```
pnpm gates          Full validation: generate, typecheck, lint, format check, duplicates, test, build, packed contents
pnpm generate       Regenerate the scratch Prisma client and its DDL; gates runs it first
pnpm test           Run the test suite once (vitest run)
pnpm typecheck      Type-check without emitting (tsc --noEmit)
pnpm lint           ESLint
pnpm build          Compile to dist/ (tsconfig.build.json)
pnpm pack:check     Assert the tarball's contents; needs a current dist/
pnpm format         Prettier write
pnpm format:check   Prettier check without writing
pnpm duplicates     jscpd copy-paste detection
```

Each script echoes a `--<name> OK--` marker on success.
A fresh clone runs `pnpm install` and `pnpm generate` before a bare `pnpm test` or `pnpm typecheck`; both need the generated test client, and only `pnpm gates` supplies it on its own.
Run `pnpm format` after making changes so the diff stays limited to what you actually touched.

**Before considering a change done, it must pass the gate:** `pnpm gates` — generate, typecheck, lint, format check, duplicates, test, build, packed contents. CI runs the same list, step by step, on every pull request.

## Testing

The project uses [Vitest](https://vitest.dev), Node-only. Tests are colocated with the code they cover as `*.test.ts` next to the source file; shared test helpers live in `src/tests/`. Test files are excluded from the published build. The project is developed with TDD.

Tests run against the scratch client generated from `prisma/schema.prisma` into `src/tests/generated/`, on a throwaway in-memory SQLite database opened through `@prisma/adapter-better-sqlite3`; `src/tests/client.ts` provides that client. Run `pnpm generate` after changing the scratch schema.

Type-level assertions (`expectTypeOf`, `@ts-expect-error`) sit in the same test files and are enforced by the `typecheck` gate, so they need no extra Vitest configuration.

## Comments

A comment earns its place only by stating a constraint the code cannot express, in the present tense — write for a reader who never saw the pull request. Do not write what the next line does, why one approach was chosen over another, when something was added, or what is planned; that belongs in the PR or an ADR. JSDoc on an exported symbol is a contract rather than a comment, and should carry an `@example`.

## Naming

One dialect, in documentation and in code alike.

- The Factorio a bootstrap hands back is named `prismaFactorio` — `const prismaFactorio = initPrismaFactorio(…)`.
- A variable holding a `Factory` ends in `Factory`, whether it is named for its model or for its flavour: `userFactory`, `postFactory`, `guestFactory`, `creditedFactory`. Name the model too where one stem would otherwise serve two of them in the same file — `creditedPostFactory`.
- Everything else takes a bare noun, rows especially: `ada`, `authors`, `drafts`. The suffix is what says "factory", so its absence says "data".
- The suffix earns its place by telling a factory from data of the same noun, so it is dropped where it cannot: a binding already named `factory`, and one holding either a factory or rows — `children` — which the suffix would misdescribe half the time.

This governs the repository — its README, its JSDoc examples and its tests. It is not imposed on consumers, who name their own variables.

## Language

All content in this repository is written in English — skill files, documentation, code, and commit messages — regardless of the language used in conversation.

## Agent skills

### Issue tracker

Issues live on GitHub at `flolefebvre/prisma-factorio`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

The `gh` CLI posts as the repo owner, so agent-authored comments are indistinguishable from the owner's. When posting or answering a comment on an issue or PR, start the body with `🤖 Claude` so readers can tell who wrote it.

### Labels

Canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus the `prd` type label, all using default names. See `docs/agents/labels.md`.

### Domain docs

Domain glossary in `CONTEXT.md` at the repo root; architectural decisions in `docs/adr/`. See `docs/agents/domain.md`.

### External docs

Use the `find-docs` skill eagerly when working against an external API — especially Prisma's, whose type surface and generator output changed sharply between majors; trained-in knowledge of them is often stale.
