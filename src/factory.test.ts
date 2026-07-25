import { expect, test, vi } from "vitest";
import type { Factorio } from "./factorio.js";
import type { EvaluationContext, Factory } from "./factory.js";
import { disposableClient, factorioHarness, userDefinition } from "./tests/factorio.js";
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

function statefulUsers(f: Factorio<TestClient>) {
  return f.define("user", {
    definition: userDefinition,
    states: {
      suspended: { name: null },
      renamed: { name: "Grace" },
      untouched: { name: undefined },
      vip: ({ attrs, uid }) => ({ email: `vip-${uid}@example.com`, name: `${String(attrs.name)} the VIP` }),
    },
  });
}

test("a declared state applies its attributes through the fluent method it is named after", async () => {
  const { f } = await factorioHarness();
  const users = f.define("user", { definition: userDefinition, states: { renamed: { name: "Grace" } } });

  const user = await users.renamed().create();

  expect(user.name).toBe("Grace");
});

test("a declared closure state computes its attributes from the evaluation context", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).vip().create();

  expect(user.email).toMatch(/^vip-\w+@example\.com$/);
});

test("a state closure reads the definition's attributes through attrs", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).vip().create();

  expect(user.name).toBe("Ada the VIP");
});

test("a state closure reads an earlier state's attributes through attrs", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).renamed().vip().create();

  expect(user.name).toBe("Grace the VIP");
});

test("chaining two states applies both, the later one winning the keys they share", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).vip().renamed().create();

  expect(user.name).toBe("Grace");
  expect(user.email).toMatch(/^vip-/);
});

test("create(overrides) wins over every state applied before it", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).renamed().vip().create({ name: "Ada" });

  expect(user.name).toBe("Ada");
});

test("a state key valued undefined is skipped, leaving the layer before it standing", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).renamed().untouched().create();

  expect(user.name).toBe("Grace");
});

test("a state key valued null is written rather than skipped", async () => {
  const { f } = await factorioHarness();

  const user = await statefulUsers(f).renamed().suspended().create();

  expect(user.name).toBeNull();
});

test("a key a state leaves undefined reaches the next state's attrs as absent, not as a hole", async () => {
  const { f } = await factorioHarness();
  const users = f.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@example.com` }),
    states: {
      unnamed: { name: undefined },
      reporting: ({ attrs }) => ({ name: "name" in attrs ? "held" : "absent" }),
    },
  });

  const user = await users.unnamed().reporting().create();

  expect(user.name).toBe("absent");
});

test("a state method returns a new factory rather than changing the one it was called on", async () => {
  const { f } = await factorioHarness();
  const users = statefulUsers(f);

  const suspended = users.suspended();
  const user = await users.create();

  expect(suspended).not.toBe(users);
  expect(user.name).toBe("Ada");
});

test("a state evaluates once per record, seeing that record's index and uid", async () => {
  const { f } = await factorioHarness();
  const users = f.define("user", {
    definition: userDefinition,
    states: { numbered: ({ index, uid }) => ({ email: `${uid}-${String(index)}@example.com` }) },
  });

  const rows = await users.numbered().count(3).create();

  expect(rows.map((row) => row.email.replace(/^\w+-|@.*$/g, ""))).toStrictEqual(["0", "1", "2"]);
  expect(new Set(rows.map((row) => row.email)).size).toBe(3);
});

test("a state applies through the client using() redirected the chain to", async () => {
  const { prisma, f } = await factorioHarness();
  const elsewhere = await disposableClient();

  await statefulUsers(f).suspended().using(elsewhere).create();

  await expect(elsewhere.user.findFirstOrThrow()).resolves.toMatchObject({ name: null });
  await expect(prisma.user.count()).resolves.toBe(0);
});

test("a state named after a factory method is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take a name the factory already answers to
    f.define("user", { definition: userDefinition, states: { create: { name: "Grace" } } }),
  ).toThrow('The state "create" collides with the factory method of the same name. Rename the state.');
});

test("creating never opens a transaction of its own", async () => {
  const { prisma, users } = await factorioHarness();
  const transaction = vi.spyOn(prisma, "$transaction");

  await users.count(2).create();

  expect(transaction).not.toHaveBeenCalled();
});
