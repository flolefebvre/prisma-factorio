# Code generation via a custom Prisma generator

prisma-factorio needs full type safety — required fields, relations, and typed magic relationship methods (`hasPosts`, `forUser`) — which TypeScript cannot derive from a Prisma schema without codegen, and since Prisma 7 the DMMF is no longer available at runtime. We build the library as a custom Prisma generator (`generator factorio { provider = "prisma-factorio" }`) implemented with `@prisma/generator-helper`, emitting per-model factory code on every `prisma generate`.

## Considered Options

- **Custom Prisma generator (chosen)** — full schema knowledge at generation time, typed magic methods possible, plugs into the existing `prisma generate` workflow.
- **Pure runtime generics over `Prisma.*Input` types** — rejected: cannot type magic methods, cannot know required fields or relations at runtime.
- **Client extension via `$extends`** — rejected for the same typing limits as runtime generics.

## Consequences

`@prisma/generator-helper` is labeled internal-use by Prisma with no semver guarantee. We accept this because the whole community generator ecosystem rests on it, we pin its version per supported Prisma release, and breakage surfaces loudly at generate time (CI), never at runtime in user tests. Prisma 7 is the minimum supported version.
