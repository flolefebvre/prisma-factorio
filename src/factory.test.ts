import { expect, test, vi } from "vitest";
import type { Factorio } from "./factorio.js";
import type { EvaluationContext, Factory } from "./factory.js";
import { disposableClient, factorioHarness } from "./tests/factorio.js";
import type { TestClient } from "./tests/client.js";

interface Recorder {
  contexts: EvaluationContext[];
  factory: Factory<TestClient, "user">;
}

// The contexts are kept rather than read: `faker` is compared by identity, never by property, so a
// recorder works whether or not @faker-js/faker is installed.
function recorder(f: Factorio<TestClient>): Recorder {
  const contexts: EvaluationContext[] = [];

  return {
    contexts,
    factory: f.define("user", {
      definition: (context) => {
        contexts.push(context);
        return { email: `${context.uid}@example.com` };
      },
    }),
  };
}

test("create() returns the persisted row, database-generated fields included", async () => {
  const { prisma, users } = await factorioHarness();

  const user = await users.create();

  expect(user.id).toBeGreaterThan(0);
  expect(user.name).toBe("Ada");
  await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ name: "Ada" });
});

test("create(overrides) replaces only the attributes it names", async () => {
  const { users } = await factorioHarness();

  const user = await users.create({ name: "Grace" });

  expect(user.name).toBe("Grace");
  expect(user.email).toMatch(/@example\.com$/);
});

test("create(overrides) skips a key whose value is undefined, leaving the definition's value", async () => {
  const { users } = await factorioHarness();

  const user = await users.create({ name: undefined });

  expect(user.name).toBe("Ada");
});

test("create(overrides) writes the null a key carries rather than skipping it", async () => {
  const { users } = await factorioHarness();

  const user = await users.create({ name: null });

  expect(user.name).toBeNull();
});

test("count(3).create() returns three rows", async () => {
  const { prisma, users } = await factorioHarness();

  const rows = await users.count(3).create();

  expect(rows).toHaveLength(3);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("count() rejects a batch size that is not a whole number, naming the value", async () => {
  const { users } = await factorioHarness();

  for (const records of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => users.count(records)).toThrow(
      `count(${String(records)}) is not a batch size. Pass a non-negative whole number.`,
    );
  }
});

test("count(0) creates no records", async () => {
  const { prisma, users } = await factorioHarness();

  await expect(users.count(0).create()).resolves.toStrictEqual([]);
  await expect(prisma.user.count()).resolves.toBe(0);
});

test("index counts up from 0 within a batch and restarts on the next one", async () => {
  const { f } = await factorioHarness();
  const { contexts, factory } = recorder(f);

  await factory.count(3).create();
  await factory.count(2).create();

  expect(contexts.map((context) => context.index)).toStrictEqual([0, 1, 2, 0, 1]);
});

test("records created in one run draw distinct uids", async () => {
  const { f } = await factorioHarness();
  const { contexts, factory } = recorder(f);

  await factory.count(2).create();
  await factory.create();

  expect(new Set(contexts.map((context) => context.uid)).size).toBe(3);
});

test("every record in a batch reads the same faker", async () => {
  const { f } = await factorioHarness();
  const { contexts, factory } = recorder(f);

  await factory.count(2).create();

  expect(contexts[0]?.faker).toBe(contexts[1]?.faker);
});

test("count returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, users } = await factorioHarness();

  const batch = users.count(3);
  await users.create();

  expect(batch).not.toBe(users);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("using returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, users } = await factorioHarness();
  const elsewhere = await disposableClient();

  await users.using(elsewhere).create();
  await users.create();

  await expect(elsewhere.user.count()).resolves.toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The transaction runs on `target` and the rollback is observed on `target`: an in-memory SQLite
// database belongs to one connection, so a second client would be a second, empty database and the
// assertion would hold whatever the factory did. Bootstrapping elsewhere keeps it discriminating —
// records reach `target` only because `.using(tx)` redirected them.
test("using(tx) writes through the transaction, so a rollback drops the records", async () => {
  const { prisma: bootstrap, users } = await factorioHarness();
  const target = await disposableClient();
  const rollback = new Error("rollback");

  const outcome: unknown = await target
    .$transaction(async (tx) => {
      await users.using(tx).count(2).create();
      await expect(tx.user.count()).resolves.toBe(2);
      throw rollback;
    })
    .catch((error: unknown) => error);

  expect(outcome).toBe(rollback);
  await expect(target.user.count()).resolves.toBe(0);
  await expect(bootstrap.user.count()).resolves.toBe(0);
});

test("creating never opens a transaction of its own", async () => {
  const { prisma, users } = await factorioHarness();
  const transaction = vi.spyOn(prisma, "$transaction");

  await users.count(2).create();

  expect(transaction).not.toHaveBeenCalled();
});
