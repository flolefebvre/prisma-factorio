# Using prisma-factorio with @flefebvre/prisma-test-helper

[`@flefebvre/prisma-test-helper`](https://github.com/flolefebvre/prisma-test-helper) is a Postgres test harness for Prisma + Vitest: one throwaway container per run, one database per worker, and every test wrapped in a transaction that is rolled back. Paired with prisma-factorio, factories build their whole graph inside that transaction, and the rollback is the cleanup — no truncation, no leftover rows.

The pairing needs no adapter and no extra wiring. The harness replaces the app's Prisma client with a routing proxy under the same type; prisma-factorio reads relation metadata and issues its queries through whatever client it was bootstrapped on, and the proxy routes each call into whichever test transaction is live when the call is made.

## Wiring

Wire the harness first — its own README covers the five files. The one rule the pairing adds: **bootstrap prisma-factorio on the same client module the harness mocks**, imported by the same path.

```ts
// tests/factories.ts
import { initPrismaFactorio } from "@flefebvre/prisma-factorio";
import { db } from "../src/db/client.js"; // the module named in the setup file's vi.mock

const prismaFactorio = initPrismaFactorio(() => db);

export const userFactory = prismaFactorio.define("user", {
  definition: ({ faker, uid }) => ({
    email: `user-${uid}@example.com`,
    name: faker.person.fullName(),
  }),
});

export const postFactory = prismaFactorio.define("post", {
  definition: ({ faker }) => ({
    title: faker.lorem.sentence(),
    author: userFactory,
  }),
});
```

Under Vitest the `db` this module receives is already the harness's proxy, so every factory write lands in the live test transaction. Outside Vitest — a seed script, say — the same module receives the real client and the factories work unchanged.

A test file then opts in and creates what it needs:

```ts
import { expect, test } from "vitest";
import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";
import { postFactory, userFactory } from "./factories.js";

setupDatabase();

test("lists an author's posts", async () => {
  const ada = await userFactory.create({ name: "Ada" });
  await postFactory.count(3).for(ada, "author").create();

  expect(await db.post.count()).toBe(3);
});
```

Every row the graph created — the posts, the author, anything a relation default or `has` added — is discarded by the rollback when the test ends.

## Rules

- **Create records inside tests**, never in `beforeAll`. The harness opens the transaction in `beforeEach`; a factory create before that fails with its `the database was touched with no test transaction live` guard rather than committing to the worker database. `beforeEach` hooks registered after `setupDatabase()` are fine.
- **`using(tx)` is unnecessary under the harness.** Every call already lands in the live transaction; reach for `using` only where a test opens a nested `$transaction` of its own.
- A shared factories module can fail loudly when a test file forgot to opt in:

  ```ts
  import { isDatabaseSetUp } from "@flefebvre/prisma-test-helper";

  if (!isDatabaseSetUp()) {
    throw new Error("call setupDatabase() at the top of this test file");
  }
  ```

## Determinism

The harness hands `registerResetHook` a seed derived from the test name, so seeded data replays when one test is rerun alone. prisma-factorio takes its `seed` once, at `initPrismaFactorio`, and exposes no per-test reseed: within one file, faker values and recycle picks depend on how many records earlier tests in that file drew. Assert on what a test itself passed or can read back from the row, not on the exact values faker generated.
