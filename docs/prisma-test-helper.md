# Using prisma-factorio with @flefebvre/prisma-test-helper

[`@flefebvre/prisma-test-helper`](https://github.com/flolefebvre/prisma-test-helper) is a Postgres test harness for Prisma + Vitest: one throwaway container per run, one database per worker, and tests that commit for real. This guide covers its 1.0.0 lifecycle. Before a file's first test, and after every test, the harness's Reset returns every table to its Baseline: empty, except for the rows that migrations and the global-setup seed inserted, which it restores. Every sequence is rewound. Paired with prisma-factorio, factories build their whole graph through your own client, and the Reset is the cleanup.

The pairing needs no adapter and no extra wiring. The harness takes the client your app already uses, `setupDatabase(db)`, and wraps nothing. prisma-factorio reads relation metadata off that same client and issues its queries through it, so every factory write is an ordinary committed write.

## Wiring

Wire the harness first; its own README covers the five files. The one rule the pairing adds: **bootstrap prisma-factorio on the same client module you hand to `setupDatabase(db)`**, imported by the same path.

```ts
// tests/factories.ts
import { initPrismaFactorio } from "@flefebvre/prisma-factorio";
import { db } from "../src/db/client.js";

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

A test file then opts in and creates what it needs:

```ts
import { expect, test } from "vitest";
import { setupDatabase } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";
import { postFactory, userFactory } from "./factories.js";

setupDatabase(db);

test("lists an author's posts", async () => {
  const ada = await userFactory.create({ name: "Ada" });
  await postFactory.count(3).for(ada, "author").create();

  expect(await db.post.count()).toBe(3);
});
```

Every row the graph created is committed, and the Reset removes it when the test ends: the posts, the author, and anything a relation default or `has()` added.

## Lifecycle

- **Build rows per test: in the test, in `beforeEach`, or through a factory called from either.** A row a `beforeAll` of your own creates lasts only until the first test ends, when the Reset removes it like any other.
- **Build a `recycle()` pool in the test that uses it.** A pool is a list of rows you handed over, held by the factory chain. If those rows came from a `beforeAll`, or from an earlier test, the Reset has already deleted them, while the factory still holds the copies. Build the rows and the pool that recycles them in the same test or `beforeEach`.
- **A stale row fails loudly, and that is deliberate.** The Reset rewinds every sequence, so the next test's first user gets id 1 again. A stale row matched on its id alone would silently reach that unrelated new record. prisma-factorio connects a row you handed over, or one a pool drew, on every non-null scalar it holds. The new user with id 1 holds a different email, so the create fails with Prisma's `P2025` instead of wiring the wrong record. A row the factory created in the same build is never stale, and is written as its foreign key ([ADR 0005](https://github.com/flolefebvre/prisma-factorio/blob/main/docs/adr/0005-fresh-rows-as-foreign-keys.md)).
- **`using(tx)` is for transactions your test opens itself.** Factory writes already commit through the client you bootstrapped on. Reach for `using` only to put a graph inside a `$transaction` of your own.
- A shared factories module can fail loudly when a test file forgot to opt in:

  ```ts
  import { isDatabaseSetUp } from "@flefebvre/prisma-test-helper";

  if (!isDatabaseSetUp()) {
    throw new Error("call setupDatabase(db) at the top of this test file");
  }
  ```

## Determinism

The harness runs every hook given to `registerResetHook` in each `beforeEach`, handing it `{ testName, seed }`. `seed` is derived from the test name alone, so rerunning one test with `-t` hands it the same seed a full-suite run did. Hand it to the bootstrap with one line in the factories module:

```ts
// tests/factories.ts
import { initPrismaFactorio } from "@flefebvre/prisma-factorio";
import { registerResetHook } from "@flefebvre/prisma-test-helper";
import { db } from "../src/db/client.js";

const prismaFactorio = initPrismaFactorio(() => db);

registerResetHook(({ seed }) => prismaFactorio.reseed(seed));

export const userFactory = prismaFactorio.define("user", {
  definition: ({ faker, uid }) => ({ email: `user-${uid}@example.com`, name: faker.person.fullName() }),
});
```

`reseed` restarts the bootstrap's streams in place, so every factory it defined — before the hook ran or after — draws from the test's seed, and test files import and destructure the factories as usual. The seed pins faker's values and the recycle picks. It does not pin `uid`, which draws a fresh random prefix in every process, so never assert on a `uid`-derived column.
