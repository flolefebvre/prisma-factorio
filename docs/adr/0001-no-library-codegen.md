# No library codegen: everything is inferred from the generated client

Factory libraries for Prisma typically ship their own generator that emits factory classes per model. We instead bind to what `prisma generate` already produces: model, input, and output types are derived at the type level via Prisma's public type utilities (`Prisma.Args`, `Prisma.Result`, `Prisma.Payload`), and runtime schema metadata comes from the client instance. Users get factories with zero extra build step; the cost is coupling to Prisma's type surface, mitigated by the `>=7 <8` peer range.

## Considered Options

- Own generator registered in `schema.prisma` (the `prisma-factory` approach) — rejected: adds a build step and emitted files to every consumer.
- Parsing `schema.prisma` at runtime — rejected: duplicate source of truth, no type-level story.
