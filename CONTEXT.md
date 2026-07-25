# prisma-factorio

A Laravel-style model factory library for Prisma (TypeScript), built as a custom Prisma generator. It lets tests and seeds declare the records they need through a fluent, fully typed API instead of hand-writing every column.

`docs/laravel-factories.md` is the reference for the feature set being ported; it documents Laravel's vocabulary, not this library's API.

## Language

**Factory**:
The per-model entry point that produces data for that model.
_Avoid_: builder, fixture, seeder

**Definition**:
The mandatory default attribute set a factory starts from. It must cover every required field of the model; TypeScript enforces this coverage at compile time. There is no auto-fill: leaving a required field out is a deliberate compile error, not a fallback.
_Avoid_: defaults, blueprint, auto-fill
