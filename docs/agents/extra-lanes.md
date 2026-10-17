# The lanes outside the gate

`pnpm gates` needs neither Docker nor a long type-check, so two lanes run beside it, each as its own CI job.

## Type-level compile cost — `pnpm bench:types`

It regenerates a synthetic 100-model schema, type-checks a factory per model beside a control that only constructs the client, and prints the instantiation count, check time and memory of both. It fails when the factory file's instantiations exceed `scripts/bench-types/budget.json`, the measured baseline plus 20%.

A change that lowers the count lowers the budget in the same pull request. A change that raises it past the budget states the measured cost in its pull request body.

## Postgres — `pnpm test:postgres`

It starts a `postgres:17-alpine` container through Testcontainers, with autovacuum off, unless `POSTGRES_URL` holds a connection string, in which case that server is used instead. With neither, it fails naming both.

A server named by `POSTGRES_URL` runs Postgres 15 or later (the lane calls `pg_stat_force_next_flush()`), on a role allowed to create and drop databases, since every client gets a database of its own. With autovacuum on, the exact commit-count tests can see one extra commit.
