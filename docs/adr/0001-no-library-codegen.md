# No library codegen: everything is inferred from the generated client

Types are derived through Prisma's public type utilities (`Prisma.Args`, `Prisma.Result`, `Prisma.Payload`); runtime metadata is read off the client instance. Consumers get factories with zero extra build step; the cost is coupling to Prisma's type surface, contained by the `>=7 <8` peer range.

## Considered Options

- A generator of our own registered in `schema.prisma` — rejected: a build step and emitted files for every consumer.
- Parsing the `schema.prisma` file at runtime — rejected: a second source of truth beside the client. (The inline copy the client itself carries is not that; see ADR 0004.)
