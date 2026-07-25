# prisma-factorio

## Context

This project is a Laravel-style model factory library for Prisma (TypeScript), built as a custom Prisma generator. Tests and seeds declare the records they need through a fluent, fully typed API instead of hand-writing every column. Full type safety is the core promise: definitions must cover every required field of a model, or the code does not compile.

`docs/laravel-factories.md` is the reference for the feature set being ported. The public API is not settled — nothing outside that document should be treated as decided.

## Stack

TypeScript (strict, ESM) · Node ≥ 20 · built on `@prisma/generator-helper` (Prisma ≥ 7 < 8 as peer dependency) · Vitest · ESLint + Prettier + jscpd. Package manager: pnpm.

## Layout

```
src/
  generator.ts    Prisma generator entry point (the `prisma-factorio` bin)
  index.ts        Public runtime API (package root export)
  tests/          Shared test helpers (never published)
docs/
  adr/            Architectural decision records
  agents/         Agent workflow docs (issue tracker, labels, domain)
  laravel-factories.md   Laravel factories docs (original reference)
```

## Commands

All via pnpm.

```
pnpm gates          Full validation: typecheck, lint, format check, duplicates, test, build
pnpm test           Run the test suite once (vitest run)
pnpm typecheck      Type-check without emitting (tsc --noEmit)
pnpm lint           ESLint
pnpm build          Compile to dist/ (tsconfig.build.json)
pnpm format         Prettier write
pnpm duplicates     jscpd copy-paste detection
```

Each script echoes a `--<name> OK--` marker on success.
Run `pnpm format` after making changes so the diff stays limited to what you actually touched.

**Before considering a change done, it must pass the gate:** `pnpm gates` — typecheck, lint, format check, duplicates, test, build.

## Testing

The project uses [Vitest](https://vitest.dev), Node-only. Tests are colocated with the code they cover as `*.test.ts` next to the source file; shared test helpers live in `src/tests/`. Test files are excluded from the published build. The project is developed with TDD.

## Comments

A comment earns its place only by stating a constraint the code cannot express, in the present tense — write for a reader who never saw the pull request. Do not write what the next line does, why one approach was chosen over another, when something was added, or what is planned; that belongs in the PR or an ADR. JSDoc on an exported symbol is a contract rather than a comment, and should carry an `@example`.

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
