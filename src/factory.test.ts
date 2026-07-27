import { expect, expectTypeOf, onTestFinished, test, vi, type MockedFunction } from "vitest";
import { holdsManyRecords, inverseRelationField } from "./datamodel.js";
import type { FactorioOptions } from "./faker.js";
import { initPrismaFactorio, type Factorio } from "./factorio.js";
import type { EvaluationContext, Factory, FactoryConfig, StateContext } from "./factory.js";
import type { ModelName, Row } from "./prisma.js";
import { disposableClient, factorioHarness, userDefinition, type Harness } from "./tests/factorio.js";
import type { TestClient } from "./tests/client.js";

// Every export keeps its own implementation and gains a spy, which is what lets one test replace the
// inverse lookup alone while every other test in this file runs against the real module.
vi.mock("./datamodel.js", { spy: true });

interface Recorder {
  contexts: EvaluationContext[];
  factory: Factory<TestClient, "user">;
}

// The contexts are kept rather than read: `faker` is compared by identity, never by property, so a
// recorder works whether or not @faker-js/faker is installed.
function recorder(prismaFactorio: Factorio<TestClient>): Recorder {
  const contexts: EvaluationContext[] = [];

  return {
    contexts,
    factory: prismaFactorio.define("user", {
      definition: (context) => {
        contexts.push(context);
        return { email: `${context.uid}@example.com` };
      },
    }),
  };
}

test("create() returns the persisted row, database-generated fields included", async () => {
  const { prisma, userFactory } = await factorioHarness();

  const user = await userFactory.create();

  expect(user.id).toBeGreaterThan(0);
  expect(user.name).toBe("Ada");
  await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ name: "Ada" });
});

test("create(overrides) replaces only the attributes it names", async () => {
  const { userFactory } = await factorioHarness();

  const user = await userFactory.create({ name: "Grace" });

  expect(user.name).toBe("Grace");
  expect(user.email).toMatch(/@example\.com$/);
});

test("create(overrides) skips a key whose value is undefined, leaving the definition's value", async () => {
  const { userFactory } = await factorioHarness();

  const user = await userFactory.create({ name: undefined });

  expect(user.name).toBe("Ada");
});

test("create(overrides) writes the null a key carries rather than skipping it", async () => {
  const { userFactory } = await factorioHarness();

  const user = await userFactory.create({ name: null });

  expect(user.name).toBeNull();
});

test("count(3).create() returns three rows", async () => {
  const { prisma, userFactory } = await factorioHarness();

  const rows = await userFactory.count(3).create();

  expect(rows).toHaveLength(3);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("count() rejects a batch size that is not a whole number, naming the value", async () => {
  const { userFactory } = await factorioHarness();

  for (const records of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => userFactory.count(records)).toThrow(
      `count(${String(records)}) is not a batch size. Pass a non-negative whole number.`,
    );
  }
});

test("count(0) creates no records", async () => {
  const { prisma, userFactory } = await factorioHarness();

  await expect(userFactory.count(0).create()).resolves.toStrictEqual([]);
  await expect(prisma.user.count()).resolves.toBe(0);
});

test("index counts up from 0 within a batch and restarts on the next one", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { contexts, factory } = recorder(prismaFactorio);

  await factory.count(3).create();
  await factory.count(2).create();

  expect(contexts.map((context) => context.index)).toStrictEqual([0, 1, 2, 0, 1]);
});

test("records created in one run draw distinct uids", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { contexts, factory } = recorder(prismaFactorio);

  await factory.count(2).create();
  await factory.create();

  expect(new Set(contexts.map((context) => context.uid)).size).toBe(3);
});

test("every record in a batch reads the same faker", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { contexts, factory } = recorder(prismaFactorio);

  await factory.count(2).create();

  expect(contexts[0]?.faker).toBe(contexts[1]?.faker);
});

test("count returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, userFactory } = await factorioHarness();

  const batchFactory = userFactory.count(3);
  await userFactory.create();

  expect(batchFactory).not.toBe(userFactory);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("using returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, userFactory } = await factorioHarness();
  const elsewhere = await disposableClient();

  await userFactory.using(elsewhere).create();
  await userFactory.create();

  await expect(elsewhere.user.count()).resolves.toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The transaction runs on `target` and the rollback is observed on `target`: an in-memory SQLite
// database belongs to one connection, so a second client would be a second, empty database and the
// assertion would hold whatever the factory did. Bootstrapping elsewhere keeps it discriminating —
// records reach `target` only because `.using(tx)` redirected them.
test("using(tx) writes through the transaction, so a rollback drops the records", async () => {
  const { prisma: source, userFactory } = await factorioHarness();
  const target = await disposableClient();
  const rollback = new Error("rollback");

  const outcome: unknown = await target
    .$transaction(async (tx) => {
      await userFactory.using(tx).count(2).create();
      await expect(tx.user.count()).resolves.toBe(2);
      throw rollback;
    })
    .catch((error: unknown) => error);

  expect(outcome).toBe(rollback);
  await expect(target.user.count()).resolves.toBe(0);
  await expect(source.user.count()).resolves.toBe(0);
});

function statefulUsers(prismaFactorio: Factorio<TestClient>) {
  return prismaFactorio.define("user", {
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
  const { prismaFactorio } = await factorioHarness();
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    states: { renamed: { name: "Grace" } },
  });

  const user = await userFactory.renamed().create();

  expect(user.name).toBe("Grace");
});

test("a declared closure state computes its attributes from the evaluation context", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).vip().create();

  expect(user.email).toMatch(/^vip-\w+@example\.com$/);
});

test("a state closure reads the definition's attributes through attrs", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).vip().create();

  expect(user.name).toBe("Ada the VIP");
});

test("a state closure reads an earlier state's attributes through attrs", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).renamed().vip().create();

  expect(user.name).toBe("Grace the VIP");
});

test("chaining two states applies both, the later one winning the keys they share", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).vip().renamed().create();

  expect(user.name).toBe("Grace");
  expect(user.email).toMatch(/^vip-/);
});

test("create(overrides) wins over every state applied before it", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).renamed().vip().create({ name: "Ada" });

  expect(user.name).toBe("Ada");
});

test("a state key valued undefined is skipped, leaving the layer before it standing", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).renamed().untouched().create();

  expect(user.name).toBe("Grace");
});

test("a state key valued null is written rather than skipped", async () => {
  const { prismaFactorio } = await factorioHarness();

  const user = await statefulUsers(prismaFactorio).renamed().suspended().create();

  expect(user.name).toBeNull();
});

test("a key a state leaves undefined reaches the next state's attrs as absent, not as a hole", async () => {
  const { prismaFactorio } = await factorioHarness();
  const userFactory = prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@example.com` }),
    states: {
      unnamed: { name: undefined },
      reporting: ({ attrs }) => ({ name: "name" in attrs ? "held" : "absent" }),
    },
  });

  const user = await userFactory.unnamed().reporting().create();

  expect(user.name).toBe("absent");
});

test("a state method returns a new factory rather than changing the one it was called on", async () => {
  const { prismaFactorio } = await factorioHarness();
  const userFactory = statefulUsers(prismaFactorio);

  const suspendedFactory = userFactory.suspended();
  const user = await userFactory.create();

  expect(suspendedFactory).not.toBe(userFactory);
  expect(user.name).toBe("Ada");
});

test("a state evaluates once per record, seeing that record's index and uid", async () => {
  const { prismaFactorio } = await factorioHarness();
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    states: { numbered: ({ index, uid }) => ({ email: `${uid}-${String(index)}@example.com` }) },
  });

  const rows = await userFactory.numbered().count(3).create();

  expect(rows.map((row) => row.email.replace(/^\w+-|@.*$/g, ""))).toStrictEqual(["0", "1", "2"]);
  expect(new Set(rows.map((row) => row.email)).size).toBe(3);
});

test("a state applies through the client using() redirected the chain to", async () => {
  const { prisma, prismaFactorio } = await factorioHarness();
  const elsewhere = await disposableClient();

  await statefulUsers(prismaFactorio).suspended().using(elsewhere).create();
  await statefulUsers(prismaFactorio).using(elsewhere).suspended().create();

  await expect(elsewhere.user.findMany()).resolves.toMatchObject([{ name: null }, { name: null }]);
  await expect(prisma.user.count()).resolves.toBe(0);
});

test("a state closure is handed the definition's context, plus attrs and parent", async () => {
  const { prismaFactorio } = await factorioHarness();
  const seen: unknown[] = [];
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    states: {
      recorded: (context) => {
        expectTypeOf(context).toEqualTypeOf<StateContext<TestClient, "user">>();
        seen.push(context);
        return {};
      },
    },
  });

  await userFactory.recorded().create();

  expect(seen[0]).toMatchObject({ index: 0, parent: undefined, attrs: { name: "Ada" } });
});

test("a state leaves the row typing of the chain it is applied to untouched", async () => {
  const { prismaFactorio } = await factorioHarness();
  const userFactory = statefulUsers(prismaFactorio);

  const one = await userFactory.suspended().create();
  const many = await userFactory.count(2).suspended().create();

  const inline = await userFactory.state({ name: "Grace" }).create();

  expectTypeOf(one).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(inline).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(many).toEqualTypeOf<Row<TestClient, "user">[]>();
  expect(many.map((row) => row.name)).toStrictEqual([null, null]);
});

test("a state named after a factory method is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take a name the factory already answers to
    prismaFactorio.define("user", { definition: userDefinition, states: { create: { name: "Grace" } } }),
  ).toThrow('The state "create" takes a name a factory reserves. Rename the state.');
});

// A factory carrying a `then` is thenable, so awaiting one — or returning it from an async
// function — would hand the awaiter a state method and never settle.
test("a state named then is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not be named after the thenable protocol
    prismaFactorio.define("user", { definition: userDefinition, states: { then: { name: "Grace" } } }),
  ).toThrow('The state "then" takes a name a factory reserves. Rename the state.');
});

test("a state named for is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the belongs-to method answers to
    prismaFactorio.define("user", { definition: userDefinition, states: { for: { name: "Grace" } } }),
  ).toThrow('The state "for" takes a name a factory reserves. Rename the state.');
});

test("a state named has is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the has-many method answers to
    prismaFactorio.define("user", { definition: userDefinition, states: { has: { name: "Grace" } } }),
  ).toThrow('The state "has" takes a name a factory reserves. Rename the state.');
});

test("a state named recycle is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the recycle method answers to
    prismaFactorio.define("user", { definition: userDefinition, states: { recycle: { name: "Grace" } } }),
  ).toThrow('The state "recycle" takes a name a factory reserves. Rename the state.');
});

test("a state named afterCreating is rejected where the factory is defined", async () => {
  const { prismaFactorio } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the callback method answers to
    prismaFactorio.define("user", { definition: userDefinition, states: { afterCreating: { name: "Grace" } } }),
  ).toThrow('The state "afterCreating" takes a name a factory reserves. Rename the state.');
});

test("a state named __proto__ becomes a method rather than a write to the prototype", async () => {
  const { prismaFactorio } = await factorioHarness();
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    states: { ["__proto__"]: { name: "Grace" } },
  });

  const user = await userFactory.__proto__().create();

  expect(user.name).toBe("Grace");
});

test("creating never opens a transaction of its own", async () => {
  const { prisma, userFactory } = await factorioHarness();
  const transaction = vi.spyOn(prisma, "$transaction");

  await userFactory.count(2).create();

  expect(transaction).not.toHaveBeenCalled();
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function statesCheckedByTheCompiler(prismaFactorio: Factorio<TestClient>, client: TestClient): void {
  // Held rather than written inline: excess property checking reaches a fresh object literal only,
  // so a variable is what tells `Exact` apart from the compiler's own freshness rule.
  const held = { name: "Ada", nmae: "x" };
  const userFactory = statefulUsers(prismaFactorio);

  void userFactory.suspended().vip().create();
  void userFactory.count(3).suspended().create();
  void userFactory.using(client).vip().create();
  prismaFactorio.define("user", {
    definition: userDefinition,
    states: { withPost: { posts: { create: { title: "t" } } } },
  });

  // @ts-expect-error a state the config does not declare
  void userFactory.suspndd;
  // @ts-expect-error a state naming a field the model does not have
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: { nmae: "Ada" } } });
  // @ts-expect-error a state giving a field the wrong value type
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: { name: 42 } } });
  // @ts-expect-error a state held in a variable, which excess property checking does not reach
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: held } });
  // @ts-expect-error a state closure returning a field the model does not have
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: () => ({ nmae: "Ada" }) } });
  // @ts-expect-error a state closure returning an object excess property checking does not reach
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: () => held } });
  // @ts-expect-error a state naming a field the nested relation input does not have
  prismaFactorio.define("user", { definition: userDefinition, states: { bad: { posts: { create: { titel: "t" } } } } });

  void userFactory.state({ name: "Grace" }).suspended().count(2).create();
  void userFactory.state(({ attrs }) => ({ name: attrs.name ?? "Ada" })).create();
  // A closure returning a different shape per branch: both application sites must take it.
  void userFactory.state(({ index }) => (index === 0 ? { name: "Ada" } : { email: "grace@example.com" })).create();
  prismaFactorio.define("user", {
    definition: userDefinition,
    states: { alternating: ({ index }) => (index === 0 ? { name: "Ada" } : { email: "grace@example.com" }) },
  });

  // @ts-expect-error one branch of a state closure naming a field the model does not have
  void userFactory.state(({ index }) => (index === 0 ? { name: "Ada" } : { nmae: "Grace" }));
  // @ts-expect-error a config annotated without its state names carries no states
  const annotated: FactoryConfig<TestClient, "user"> = { definition: userDefinition, states: { bad: held } };
  void annotated;

  // @ts-expect-error an inline state naming a field the model does not have
  void userFactory.state({ nmae: "Ada" });
  // @ts-expect-error an inline state held in a variable, which excess property checking does not reach
  void userFactory.state(held);
  // @ts-expect-error an inline state closure returning a field the model does not have
  void userFactory.state(() => ({ nmae: "Ada" }));
  // @ts-expect-error an inline state closure returning an object excess property checking does not reach
  void userFactory.state(() => held);
}

test("state(partial) applies attributes the config never declared", async () => {
  const { userFactory } = await factorioHarness();

  const user = await userFactory.state({ name: "Grace" }).create();

  expect(user.name).toBe("Grace");
});

test("state(closure) is handed the context a declared state closure gets", async () => {
  const { userFactory } = await factorioHarness();

  const user = await userFactory
    .state(({ attrs, index }) => ({ name: `${String(attrs.name)} ${String(index)}` }))
    .create();

  expect(user.name).toBe("Ada 0");
});

test("an inline state and a declared state apply in the order they were called", async () => {
  const { prismaFactorio } = await factorioHarness();

  const declaredLast = await statefulUsers(prismaFactorio).state({ name: "Grace" }).suspended().create();
  const inlineLast = await statefulUsers(prismaFactorio).suspended().state({ name: "Grace" }).create();

  expect(declaredLast.name).toBeNull();
  expect(inlineLast.name).toBe("Grace");
});

test("state returns a new factory rather than changing the one it was called on", async () => {
  const { userFactory } = await factorioHarness();

  const renamedFactory = userFactory.state({ name: "Grace" });
  const user = await userFactory.create();

  expect(renamedFactory).not.toBe(userFactory);
  expect(user.name).toBe("Ada");
});

// Everything a transaction client answers to that a factory of this harness reaches.
type Transaction = Pick<TestClient, "user" | "post" | "comment">;

type Delegates = Record<"user" | "post", { create: (args: { data: Record<string, unknown> }) => Promise<unknown> }>;

interface Recording {
  client: Transaction;
  written: Record<string, unknown>[];
}

// The recorded delegate hangs off a real client, which is where relation metadata is read from: a
// bare object of delegates carries none.
function recording(base: Transaction, model: "user" | "post"): Recording {
  const written: Record<string, unknown>[] = [];
  const source = (base as unknown as Delegates)[model];
  const delegate = Object.create(source) as Delegates["user"];
  const client = Object.create(base) as Transaction;

  Object.defineProperty(delegate, "create", {
    value: (args: { data: Record<string, unknown> }): Promise<unknown> => {
      written.push(args.data);
      return source.create(args);
    },
  });
  Object.defineProperty(client, model, { value: delegate });

  return { client, written };
}

test("a factory carries the symbols relation resolution reads it by, and spreading one drops them", async () => {
  const { userFactory } = await factorioHarness();
  const spread = { ...userFactory };

  for (const name of [
    "prisma-factorio.factory",
    "prisma-factorio.rebind",
    "prisma-factorio.parent",
    "prisma-factorio.recycle",
  ]) {
    expect(Symbol.for(name) in userFactory).toBe(true);
    expect(Symbol.for(name) in spread).toBe(false);
  }
});

test("a factory embedded in a definition creates the parent and connects the record to it", async () => {
  const { prisma, postFactory } = await factorioHarness();

  const post = await postFactory.create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: post.authorId } })).resolves.toMatchObject({ name: "Ada" });
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a relation default reaching through several models creates one record of each", async () => {
  const { prisma, commentFactory } = await factorioHarness();

  const comment = await commentFactory.create();

  await expect(prisma.post.findUniqueOrThrow({ where: { id: comment.postId } })).resolves.toBeTruthy();
  await expect(prisma.post.count()).resolves.toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a factory embedded in a state creates the parent, and the layer it replaced is never evaluated", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { create: { email: `${uid}@example.com`, name: "Grace" } } }),
    states: { byAda: { author: userFactory } },
  });

  await postFactory.byAda().create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ name: "Ada" }]);
});

test("a factory embedded in create() overrides creates the parent and connects the record to it", async () => {
  const { prisma, prismaFactorio } = await factorioHarness();
  const authorFactory = prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@example.com`, name: "Hedy" }),
  });
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { connect: { id: 404 } } }),
  });

  const post = await postFactory.create({ author: authorFactory });

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ id: post.authorId, name: "Hedy" }]);
});

test("a row embedded in a relation field connects to it without creating a record", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const postFactory = prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: ada }) });

  const written = await postFactory.count(2).create();

  expect(written.map((post) => post.authorId)).toStrictEqual([ada.id, ada.id]);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("an override on a relation key replaces the definition's factory, which is never evaluated", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const grace = await userFactory.create({ name: "Grace" });

  const post = await postFactory.create({ author: grace });

  expect(post.authorId).toBe(grace.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("native relation input naming connect reaches Prisma untouched", async () => {
  const { prismaFactorio, userFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { connect: { id: ada.id } } }),
  });

  await expect(postFactory.create()).resolves.toMatchObject({ authorId: ada.id });
});

test("native relation input naming create reaches Prisma untouched", async () => {
  const { prisma, postFactory } = await factorioHarness();

  const post = await postFactory.create({ author: { create: { email: "grace@example.com", name: "Grace" } } });

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ id: post.authorId, name: "Grace" }]);
});

// Records of both models a post holds many of, already written. A comment hangs off a post of its own,
// so the post a to-many slot attaches it to is never the one it was created under; a tag hangs off no
// record at all, its factory naming none.
interface Spare {
  harness: Harness;
  first: Row<TestClient, "comment">;
  second: Row<TestClient, "comment">;
  tag: Row<TestClient, "tag">;
  other: Row<TestClient, "tag">;
}

async function spare(): Promise<Spare> {
  const harness = await factorioHarness();

  return {
    harness,
    first: await harness.commentFactory.create(),
    second: await harness.commentFactory.create(),
    tag: await harness.tagFactory.create(),
    other: await harness.tagFactory.create(),
  };
}

function ids(rows: readonly { id: number }[]): number[] {
  return rows.map((row) => row.id);
}

// What a post ended up holding on one of the two relations it holds many records in. A many-to-many
// answers in join order, which is no order the caller declared, so the ids are sorted.
async function attachedTo(prisma: TestClient, post: number, field: "comments" | "tags"): Promise<number[]> {
  const held = await prisma.post.findUniqueOrThrow({ where: { id: post }, include: { comments: true, tags: true } });

  return ids(held[field]).sort((one, next) => one - next);
}

test("an array of rows in create() overrides attaches every one of them", async () => {
  const { harness, first, second } = await spare();

  const post = await harness.postFactory.create({ comments: [first, second] });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual(ids([first, second]));
});

test("an array of rows in create() overrides attaches every one across a many-to-many", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.postFactory.create({ tags: [tag, other] });

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual(ids([tag, other]));
});

test("an array of rows in a definition attaches every one of them", async () => {
  const { harness, first, second } = await spare();
  const draftFactory = harness.prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: harness.userFactory, comments: [first, second] }),
  });

  const post = await draftFactory.create();

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual(ids([first, second]));
});

test("an array of rows in a state attaches every one of them", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.postFactory.state({ tags: [tag, other] }).create();

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual(ids([tag, other]));
});

// A relation field holding many records takes a single connect as readily as a list of them, so one
// row stands in it exactly as it stands in a field holding a single record.
test("a single row in a relation field holding many records attaches it", async () => {
  const { harness, first } = await spare();

  const post = await harness.postFactory.create({ comments: first });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual([first.id]);
});

test("a single row in a many-to-many relation field attaches it", async () => {
  const { harness, tag } = await spare();

  const post = await harness.postFactory.state({ tags: tag }).create();

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
});

// The rows reach the parent's own create and the children are created after it, so which of them the
// relation ends up holding first is not the order the calls were made in.
test("an array of rows under a has() layer on the same field attaches alongside the children", async () => {
  const { harness, first, second } = await spare();

  const post = await harness.postFactory
    .state({ comments: [first, second] })
    .has(harness.commentFactory, "comments")
    .create();
  const held = await attachedTo(harness.prisma, post.id, "comments");

  expect(held).toHaveLength(3);
  expect(held).toEqual(expect.arrayContaining(ids([first, second])));
});

test("an array of rows under a has() layer attaches alongside the children across a many-to-many", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.postFactory
    .state({ tags: [tag, other] })
    .has(harness.tagFactory, "tags")
    .create();
  const held = await attachedTo(harness.prisma, post.id, "tags");

  expect(held).toHaveLength(3);
  expect(held).toEqual(expect.arrayContaining(ids([tag, other])));
});

// A `has` layer gathers on top of the field rather than under it, so the rows a value of its own
// contributes reach the parent's own create ahead of the rows the layer adds.
test("the rows a value contributes come before the rows a later has() layer adds", async () => {
  const { harness, first, second } = await spare();
  const { client, written } = recording(harness.prisma, "post");

  await harness.postFactory
    .using(client)
    .state({ comments: [first] })
    .has([second], "comments")
    .create();

  expect(written[0]?.comments).toStrictEqual({ connect: [first, second] });
});

// Naming the field and leaving it empty would hand Prisma a nested write with nothing to do, which is
// the reading a `has` layer holding no children already takes.
test("an array holding no row leaves the relation field unwritten", async () => {
  const { prisma, postFactory } = await factorioHarness();
  const { client, written } = recording(prisma, "post");

  await postFactory.using(client).create({ comments: [], tags: [] });

  expect(Object.keys(written[0] ?? {})).toStrictEqual(["title", "author"]);
});

// A list stands for rows to connect on a relation field holding many records alone. One holding a
// single record has no reading for a list, empty or not, so the value reaches the delegate as it stands
// and Prisma refuses it rather than the field going silently unwritten.
test("an array in a relation field holding a single record reaches Prisma, which refuses it", async () => {
  const { postFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();

  for (const editor of [[], [ada]]) {
    await expect(postFactory.create({ editor })).rejects.toThrow(
      "Argument `editor`: Invalid value provided. Expected UserCreateNestedOneWithoutEditedInput",
    );
  }
});

// The whole of Prisma's own nested input at this arity, none of it read as rows to connect. The
// many-to-many takes no `createMany`, the join table Prisma hides carrying no envelope of its own.
test("native relation input in a field holding many records reaches Prisma untouched", async () => {
  const { harness, first, tag } = await spare();

  const post = await harness.postFactory.create({
    comments: { connect: [{ id: first.id }], create: [{ body: "written" }], createMany: { data: [{ body: "made" }] } },
    tags: { connectOrCreate: [{ where: { id: tag.id }, create: { label: "reused" } }] },
  });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(3);
  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
});

test("a relation default in a definition evaluates once per record, so a batch draws a parent each", async () => {
  const { prisma, postFactory } = await factorioHarness();

  const rows = await postFactory.count(3).create();

  expect(new Set(rows.map((post) => post.authorId)).size).toBe(3);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("the data handed to create carries the relation field as connect and never a foreign key column", async () => {
  const { prisma, postFactory } = await factorioHarness();
  const { client, written } = recording(prisma, "post");

  const post = await postFactory.using(client).create();
  const author = await prisma.user.findUniqueOrThrow({ where: { id: post.authorId } });

  expect(Object.keys(written[0] ?? {})).toStrictEqual(["title", "author"]);
  expect(written[0]?.author).toStrictEqual({ connect: author });
});

// The row's scalars go into the `where`, so every field beyond the unique one narrows it: a row read
// before the record changed no longer matches anything.
test("connecting a row that has since changed fails rather than reaching the record it became", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();
  await prisma.user.update({ where: { id: ada.id }, data: { name: "Grace" } });

  await expect(postFactory.create({ author: ada })).rejects.toMatchObject({ code: "P2025" });
});

// The same filter read the other way: a row is cut down to the target model's scalar names before it
// stands in the `where`, so a `Team` row `{ id, slug }` collapses to `{ id }`, which a `User` satisfies
// as readily. Ids start at 1 per model, so a wrong-model row the type system let through finds a record
// to connect rather than failing. The README bullet "A wrong-model row in a relation attribute is not
// caught" rests on this test and the one under it for what happens at runtime; `readme.test.ts` pins
// the half the compiler answers for.
test("a wrong-model row in a belongs-to attribute connects the record that shares its id", async () => {
  const { postFactory, teamFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const team = await teamFactory.create();
  expect(team.id).toBe(ada.id);

  const post = await postFactory.create({ author: team });

  expect(post.authorId).toBe(ada.id);
});

// The same collapse at the other arity, where the connect rewrites a foreign key the record already
// carries: the wrong-model row re-homes a post that belonged to somebody else.
test("a wrong-model row in a has-many attribute re-homes the record that shares its id", async () => {
  const { prisma, postFactory, teamFactory, userFactory } = await factorioHarness();
  const post = await postFactory.create();
  const team = await teamFactory.create();
  expect(team.id).toBe(post.id);

  const stranger = await userFactory.create({ posts: team });

  await expect(prisma.post.findUniqueOrThrow({ where: { id: post.id } })).resolves.toMatchObject({
    authorId: stranger.id,
  });
});

test("a factory carrying no value that could stand in a relation field never reads the relation metadata", async () => {
  const { prisma } = await factorioHarness();
  const delegates = initPrismaFactorio({ user: prisma.user });

  const user = await delegates.define("user", { definition: userDefinition }).create();

  expect(user.name).toBe("Ada");
});

// The arity of a relation field is answered by querying it, so it is asked where the value standing in
// the field reads differently at each — a list, or a factory — and of no other field: a probe of a field
// no layer named can fail on the database rather than answering. A row reads alike at both arities.
test("the arity is asked of the field a factory stands in, and of no field a row or no layer names", async () => {
  const { harness, first } = await spare();
  const oracle = vi.mocked(holdsManyRecords);

  oracle.mockClear();
  await harness.postFactory.create({ comments: first });

  expect(oracle.mock.calls.map(([, model, field]) => `${model}.${field}`)).toStrictEqual(["post.author"]);
});

// A comment cannot exist before the post it hangs off, so a child factory creating its record ahead of
// the parent brings a post of its own to satisfy that foreign key and leaves it behind once the connect
// re-points the comment. The count of posts is what tells the two timings apart, whichever layer the
// child factory arrived through.
async function commented(
  attach: (harness: Harness, children: Factory<TestClient, "comment">) => Promise<Row<TestClient, "post">>,
): Promise<void> {
  const harness = await factorioHarness();

  const post = await attach(harness, harness.commentFactory);

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(1);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
}

test("a factory in a to-many definition slot creates its children once the parent row exists", async () => {
  await commented(({ prismaFactorio, userFactory }, commentFactory) =>
    prismaFactorio
      .define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory, comments: commentFactory }) })
      .create(),
  );
});

test("a factory in a to-many state slot creates its children once the parent row exists", async () => {
  await commented(({ postFactory }, commentFactory) => postFactory.state({ comments: commentFactory }).create());
});

test("a factory in a to-many slot in create() overrides creates its children once the parent row exists", async () => {
  await commented(({ postFactory }, commentFactory) => postFactory.create({ comments: commentFactory }));
});

type ChildComments = Factory<TestClient, "comment", Row<TestClient, "comment"> | Row<TestClient, "comment">[]>;

// The children wait outside the parent's own create, which then has nothing to say about the field they
// hang off: naming it there would hand Prisma either a connect for a record that does not exist yet or a
// nested write with nothing to do, the second being the reading `has([])` already takes. One post is
// written and no other, which is what the whole list of recorded creates pins.
async function unwritten(children: (harness: Harness) => ChildComments): Promise<Harness> {
  const harness = await factorioHarness();
  const { client, written } = recording(harness.prisma, "post");

  await harness.postFactory.using(client).create({ comments: children(harness) });

  expect(written.map((data) => Object.keys(data))).toStrictEqual([["title", "author"]]);

  return harness;
}

test("a factory in a to-many slot leaves the relation field unwritten in the parent's own create", async () => {
  await unwritten(({ commentFactory }) => commentFactory);
});

test("a to-many default batched to no records at all leaves the relation field unwritten", async () => {
  const { prisma } = await unwritten(({ commentFactory }) => commentFactory.count(0));

  await expect(prisma.comment.count()).resolves.toBe(0);
});

// The far side a child reaches back through is read off the pairing metadata, the value naming none, so
// a relation whose two sides both hold many records answers here as readily as a belongs-to one. The
// label is written from the row the tag was created for, which stands only once that row exists.
test("a factory in a many-to-many slot creates its record for the parent row and joins it", async () => {
  const { prisma, prismaFactorio, postFactory } = await factorioHarness();
  const creditedFactory = prismaFactorio.define("tag", {
    definition: ({ uid }) => ({ label: uid }),
    states: { credited: ({ parent }) => ({ label: `for ${String(parentId(parent))}` }) },
  });

  const post = await postFactory.create({ tags: creditedFactory.credited() });

  await expect(attachedTo(prisma, post.id, "tags")).resolves.toHaveLength(1);
  await expect(prisma.tag.findMany()).resolves.toMatchObject([{ label: `for ${String(post.id)}` }]);
});

// The deliberate opposite of `for`, whose parent factory is evaluated once however many records the
// batch holds: children are no shared stand-in, so each record of a batch draws a set of its own and
// the graph holds no record beyond the three parents and their six children.
async function eachDrawingTwo(
  attach: (
    harness: Harness,
    children: Factory<TestClient, "comment", Row<TestClient, "comment">[]>,
  ) => Promise<Row<TestClient, "post">[]>,
): Promise<void> {
  const harness = await factorioHarness();

  const written = await attach(harness, harness.commentFactory.count(2));
  const counted = await Promise.all(
    written.map((post) => harness.prisma.comment.count({ where: { postId: post.id } })),
  );

  expect(counted).toStrictEqual([2, 2, 2]);
  await expect(harness.prisma.post.count()).resolves.toBe(3);
}

test("a to-many default in a definition draws children per parent record", async () => {
  await eachDrawingTwo(({ prismaFactorio, userFactory }, commentFactory) =>
    prismaFactorio
      .define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory, comments: commentFactory }) })
      .count(3)
      .create(),
  );
});

test("a to-many default in create() overrides draws children per parent record too", async () => {
  await eachDrawingTwo(({ postFactory }, commentFactory) => postFactory.count(3).create({ comments: commentFactory }));
});

// Comment factories that name themselves as they evaluate, so which names reach the log is which layers
// of the merge were the ones evaluated, and in what order their records were created. Each names a post
// of its own, which stands unused wherever the children are created for a parent that already exists.
interface Folded {
  harness: Harness;
  order: string[];
  tagged: (tag: string) => Factory<TestClient, "comment">;
}

async function folded(): Promise<Folded> {
  const harness = await factorioHarness();
  const order: string[] = [];
  const tagged = (tag: string): Factory<TestClient, "comment"> =>
    harness.prismaFactorio.define("comment", {
      definition: ({ uid }) => {
        order.push(tag);
        return { body: uid, post: harness.postFactory };
      },
    });

  return { harness, order, tagged };
}

// A relation default is sugar for a `has` layer in what it does and a plain layer of the merge in how it
// folds: `has` adds to what the layers before it left standing, so a field a default already filled ends
// up holding both, the default's children created first.
test("a has() layer adds to the children a to-many default left standing, the default's created first", async () => {
  const { harness, order, tagged } = await folded();
  const draftFactory = harness.prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: harness.userFactory, comments: tagged("default") }),
  });

  const post = await draftFactory.has(tagged("added"), "comments").create();

  expect(order).toStrictEqual(["default", "added"]);
  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(2);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// The other order of the same pair: every layer that is not a `has` call replaces the relation field
// whole, the children gathered on it dropped along with it and never evaluated.
test("a to-many default after has() replaces the field, the children it had gatheredFactory never evaluated", async () => {
  const { harness, order, tagged } = await folded();

  const gatheredFactory = harness.postFactory.has(tagged("dropped"), "comments");
  const post = await gatheredFactory.state({ comments: tagged("kept") }).create();

  expect(order).toStrictEqual(["kept"]);
  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(1);
  await expect(harness.prisma.comment.count()).resolves.toBe(1);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// A value standing in a relation field was named by no `has` call, so it carries the order of no layer:
// every one of them falls ahead of every layer, whichever field it stands in, and what orders two of
// them is where their keys fall in the merge. The definition names `tags` ahead of `comments`, which the
// model declares the other way round, so schema order would read the pair backwards.
test("to-many defaults create their children in key order, ahead of the children has() adds", async () => {
  const { harness, order, tagged } = await folded();
  const labelledFactory = harness.prismaFactorio.define("tag", {
    definition: ({ uid }) => {
      order.push("tag");
      return { label: uid };
    },
  });
  const draftFactory = harness.prismaFactorio.define("post", {
    definition: ({ uid }) => ({
      title: uid,
      author: harness.userFactory,
      tags: labelledFactory,
      comments: tagged("comment"),
    }),
  });

  await draftFactory.has(tagged("added"), "comments").create();

  expect(order).toStrictEqual(["tag", "comment", "added"]);
});

// Distinct from the harness's own user factory, which names every record "Ada": whichever name the
// created parent carries says which layer of the merge was the one evaluated.
function otherUsers(prismaFactorio: Factorio<TestClient>): Factory<TestClient, "user"> {
  return prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, name: "Hedy" }) });
}

test("for(factory) creates the parent and connects the record to it", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  const post = await postFactory.for(userFactory, "author").create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: post.authorId } })).resolves.toMatchObject({ name: "Ada" });
});

test("for(row) connects to a record that already exists rather than creating one", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();

  const post = await postFactory.for(ada, "author").create();

  expect(post.authorId).toBe(ada.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("for(factory) resolves the one relation the model pair shares when the name is left out", async () => {
  const { prisma, commentFactory, postFactory } = await factorioHarness();

  const comment = await commentFactory.for(postFactory).create();

  expect(comment.postId).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(1);
});

test("for(row) reads the model a row belongs to off the fields it carries when the name is left out", async () => {
  const { commentFactory, postFactory } = await factorioHarness();
  const post = await postFactory.create();

  const comment = await commentFactory.for(post).create();

  expect(comment.postId).toBe(post.id);
});

// The return annotations are checked against the client's own inference, which is what keeps these
// honest stand-ins for what `include` hands back: the model's scalars, loaded relation alongside.
async function userWithPosts({
  prisma,
  userFactory,
}: Harness): Promise<Row<TestClient, "user"> & { posts: unknown[] }> {
  const ada = await userFactory.create();

  return prisma.user.findUniqueOrThrow({ where: { id: ada.id }, include: { posts: true } });
}

async function postWithComments({
  prisma,
  postFactory,
}: Harness): Promise<Row<TestClient, "post"> & { comments: unknown[] }> {
  const post = await postFactory.create();

  return prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { comments: true } });
}

test("for(row) loaded with include connects on the row's scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness();
  const loaded = await userWithPosts(harness);
  const { client, written } = recording(harness.prisma, "post");

  const post = await harness.postFactory.using(client).for(loaded, "author").create();

  expect(post.authorId).toBe(loaded.id);
  expect(written[0]?.author).toStrictEqual({ connect: { id: loaded.id, email: loaded.email, name: loaded.name } });
});

test("for(row) loaded with include resolves the relation field when the name is left out", async () => {
  const harness = await factorioHarness();
  const loaded = await postWithComments(harness);

  const comment = await harness.commentFactory.for(loaded).create();

  expect(comment.postId).toBe(loaded.id);
});

test("a row loaded with include stands in a relation default, in a definition and in overrides", async () => {
  const harness = await factorioHarness();
  const loaded = await userWithPosts(harness);
  const authoredFactory = harness.prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: loaded }),
  });

  const fromDefinition = await authoredFactory.create();
  const fromOverrides = await harness.postFactory.create({ author: loaded });

  expect([fromDefinition.authorId, fromOverrides.authorId]).toStrictEqual([loaded.id, loaded.id]);
});

test("for() beats the relation default in the definition, which is never evaluated", async () => {
  const { prisma, prismaFactorio, postFactory } = await factorioHarness();

  await postFactory.for(otherUsers(prismaFactorio), "author").create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ name: "Hedy" }]);
});

test("for() and a state resolve the relation field they share by call order", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: { byHedy: { author: otherUsers(prismaFactorio) } },
  });

  const forLast = await postFactory.byHedy().for(userFactory, "author").create();
  const stateLast = await postFactory.for(userFactory, "author").byHedy().create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: forLast.authorId } })).resolves.toMatchObject({
    name: "Ada",
  });
  await expect(prisma.user.findUniqueOrThrow({ where: { id: stateLast.authorId } })).resolves.toMatchObject({
    name: "Hedy",
  });
});

test("create(overrides) beats for() on the relation field they share, whose parent is never evaluated", async () => {
  const { prisma, prismaFactorio, postFactory, userFactory } = await factorioHarness();
  const grace = await userFactory.create({ name: "Grace" });

  const post = await postFactory.for(otherUsers(prismaFactorio), "author").create({ author: grace });

  expect(post.authorId).toBe(grace.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("two for() calls naming different relation fields both apply", async () => {
  const { postFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const grace = await userFactory.create({ name: "Grace" });

  const post = await postFactory.for(ada, "author").for(grace, "editor").create();

  expect([post.authorId, post.editorId]).toStrictEqual([ada.id, grace.id]);
});

test("two for() calls naming one relation field resolve last-write-wins, the loser never evaluated", async () => {
  const { prisma, prismaFactorio, postFactory, userFactory } = await factorioHarness();

  const post = await postFactory.for(otherUsers(prismaFactorio), "author").for(userFactory, "author").create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ id: post.authorId, name: "Ada" }]);
});

test("count(3).for(factory) creates one parent the whole batch connects to", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  const rows = await postFactory.count(3).for(userFactory, "author").create();

  expect(new Set(rows.map((post) => post.authorId)).size).toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("each create() call draws a parent of its own, so two calls connect to two records", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const authoredFactory = postFactory.for(userFactory, "author");

  await authoredFactory.create();
  await authoredFactory.create();

  await expect(prisma.user.count()).resolves.toBe(2);
});

test("a state survives for() in either chaining order and applies", async () => {
  const { prismaFactorio, userFactory } = await factorioHarness();
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: { drafted: { title: "draft" } },
  });

  const stateLast = await postFactory.for(userFactory, "author").drafted().create();
  const forLast = await postFactory.drafted().for(userFactory, "author").create();

  expect([stateLast.title, forLast.title]).toStrictEqual(["draft", "draft"]);
});

test("for returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const ada = await userFactory.create();

  const authoredFactory = postFactory.for(ada, "author");
  await postFactory.create();

  expect(authoredFactory).not.toBe(postFactory);
  await expect(prisma.user.count()).resolves.toBe(2);
});

// Prisma reports a typo'd relation key on a required relation as the untyped key being missing, so
// the library names the key it was given itself.
test("for() rejects a relation field the model pair does not share, naming it and the candidates", async () => {
  const { postFactory, userFactory } = await factorioHarness();

  await expect(postFactory.for(userFactory, "illustrator" as unknown as "author").create()).rejects.toThrow(
    'The model "post" has no relation field "illustrator" pointing at "user". ' +
      'Relation fields on "post" pointing at "user": "author", "editor".',
  );
});

// The type layer rejects the omitted name here; the runtime says the same thing to a caller who
// compiles nothing, and names the escape hatch, which the runtime alone cannot narrow down to one.
test("for() rejects an omitted relation field where the model pair shares several, naming them", async () => {
  const { postFactory, userFactory } = await factorioHarness();
  const bypassed = postFactory as unknown as { for: (parent: unknown) => Factory<TestClient, "post"> };

  await expect(bypassed.for(userFactory).create()).rejects.toThrow(
    'The model "post" has more than one relation field pointing at "user". Pass the relation field explicitly. ' +
      'Relation fields on "post" pointing at "user": "author", "editor".',
  );
});

// A `for` call names one parent record, which a relation field holding many records has no reading
// for. The type layer rejects it; the runtime says the same thing to a caller who compiles nothing,
// rather than writing a record that hangs off no parent at all.
test("for() rejects a relation field holding many records, naming it and the arity", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const bypassing = userFactory as unknown as { for: (parent: unknown, field: string) => Factory<TestClient, "user"> };

  await expect(bypassing.for(postFactory, "posts").create()).rejects.toThrow(
    'The relation field "posts" on the model "user" holds many records, which for() has no reading for. ' +
      "Attach the records with has() instead.",
  );
  await expect(prisma.post.count()).resolves.toBe(0);
});

test("for() hands create the relation field as connect and never a foreign key column", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const { client, written } = recording(prisma, "post");
  const ada = await userFactory.create();

  await postFactory.using(client).for(ada, "editor").create();

  expect(Object.keys(written[0] ?? {})).toStrictEqual(["title", "author", "editor"]);
  expect(written[0]?.editor).toStrictEqual({ connect: ada });
});

// Every model a graph under test reaches, counted in one go: a level created through the wrong client
// is a level this misses on `tx` and finds on the client the harness bootstrapped.
type Graph = [users: number, posts: number, comments: number];

async function graphOf(client: Transaction): Promise<Graph> {
  return Promise.all([client.user.count(), client.post.count(), client.comment.count()]);
}

// The graph is expected inside the transaction and gone once it rolls back, which the counts on
// `tx` and the counts the caller makes afterwards pin from both sides.
async function rolledBack(
  target: TestClient,
  run: (tx: Transaction) => Promise<unknown>,
  inside: Graph = [1, 1, 0],
): Promise<void> {
  const rollback = new Error("rollback");

  const outcome: unknown = await target
    .$transaction(async (tx) => {
      await run(tx);
      await expect(graphOf(tx)).resolves.toStrictEqual(inside);
      throw rollback;
    })
    .catch((error: unknown) => error);

  expect(outcome).toBe(rollback);
}

// The harness bootstraps on a database of its own, so a parent created through the harness client
// rather than through `tx` survives the rollback and is counted there.
async function withoutOrphans(
  create: (harness: Harness, tx: Transaction) => Promise<unknown>,
  inside?: Graph,
): Promise<void> {
  const harness = await factorioHarness();
  const target = await disposableClient();

  await rolledBack(target, (tx) => create(harness, tx), inside);

  await expect(graphOf(target)).resolves.toStrictEqual([0, 0, 0]);
  await expect(graphOf(harness.prisma)).resolves.toStrictEqual([0, 0, 0]);
}

test("for() creates the parent through the client using() named, so a rollback drops it too", async () => {
  await withoutOrphans(({ postFactory, userFactory }, tx) => postFactory.for(userFactory, "author").using(tx).create());
});

test("a relation default in a definition is created through the client using() named", async () => {
  await withoutOrphans(({ postFactory }, tx) => postFactory.using(tx).create());
});

test("a relation default reaching through several models runs every level on that client", async () => {
  await withoutOrphans(({ commentFactory }, tx) => commentFactory.using(tx).create(), [1, 1, 1]);
});

test("a to-many default creates its children on that client too, a rollback leaving neither behind", async () => {
  await withoutOrphans(
    ({ commentFactory, postFactory }, tx) => postFactory.using(tx).create({ comments: commentFactory }),
    [1, 1, 1],
  );
});

// The recorded delegate hangs off `tx`, so the records the named client writes land in the
// transaction all the same: what the recording tells is which client they went through.
async function throughItsOwnClient(
  model: "user" | "post",
  create: (harness: Harness, own: Transaction, tx: Transaction) => Promise<unknown>,
): Promise<void> {
  const harness = await factorioHarness();
  const target = await disposableClient();
  let written: Record<string, unknown>[] = [];

  await rolledBack(target, (tx) => {
    const recorded = recording(tx, model);
    written = recorded.written;

    return create(harness, recorded.client, tx);
  });

  expect(written).toHaveLength(1);
}

test("a parent factory naming a client of its own is created through it, not the resolving one", async () => {
  await throughItsOwnClient("user", ({ postFactory, userFactory }, own, tx) =>
    postFactory.for(userFactory.using(own), "author").using(tx).create(),
  );
});

// Two bootstraps over one client: an in-memory SQLite database belongs to one connection, so a second
// client would be a second, empty database and the post could connect no user across it. What tells
// the two apart is the client each record is written through, which the recorded delegate reports —
// the recorded one for a factory the resolving chain rebound, the bare one for a factory that kept its
// own. The user is counted either way, so a run writing nothing at all fails both directions.
async function acrossBootstraps(
  bind: (userFactory: Factory<TestClient, "user">, client: TestClient) => Factory<TestClient, "user">,
): Promise<[recorded: number, created: number]> {
  const { prisma, postFactory } = await factorioHarness();
  const elsewhereFactory = initPrismaFactorio(prisma).define("user", { definition: userDefinition });
  const { client, written } = recording(prisma, "user");

  await postFactory.for(bind(elsewhereFactory, prisma), "author").using(client).create();

  return [written.length, await prisma.user.count()];
}

test("a parent factory of another bootstrap that named no client is rebound to the resolving one", async () => {
  await expect(acrossBootstraps((userFactory) => userFactory)).resolves.toStrictEqual([1, 1]);
});

test("a parent factory of another bootstrap keeps the client its own using() named", async () => {
  await expect(acrossBootstraps((userFactory, client) => userFactory.using(client))).resolves.toStrictEqual([0, 1]);
});

interface Attachable {
  harness: Harness;
  first: Row<TestClient, "post">;
  second: Row<TestClient, "post">;
}

// Two posts already in the database, each brought by an author of its own, so a user a `has` layer
// connects them to is never the one they were created under.
async function attachable(): Promise<Attachable> {
  const harness = await factorioHarness();

  return { harness, first: await harness.postFactory.create(), second: await harness.postFactory.create() };
}

async function authoredBy(prisma: TestClient, authorId: number): Promise<number[]> {
  const rows = await prisma.post.findMany({ where: { authorId }, orderBy: { id: "asc" } });

  return rows.map((post) => post.id);
}

// Every `data` a run handed the user delegate, one entry per record of the batch. The chain the
// callback hands back is read for its create alone, so a batched one stands here as readily as a
// single record's.
async function userWrites(
  harness: Harness,
  attach: (userFactory: Factory<TestClient, "user">) => { create: () => Promise<unknown> },
): Promise<Record<string, unknown>[]> {
  const { client, written } = recording(harness.prisma, "user");

  await attach(harness.userFactory.using(client)).create();

  return written;
}

async function userCreateData(
  harness: Harness,
  attach: (userFactory: Factory<TestClient, "user">) => Factory<TestClient, "user">,
): Promise<Record<string, unknown>> {
  return (await userWrites(harness, attach))[0] ?? {};
}

test("has(rows) connects records that already exist rather than creating any", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.userFactory.has([first, second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
  await expect(harness.prisma.post.count()).resolves.toBe(2);
});

test("has(row) takes one row where the relation holds many", async () => {
  const { harness, first } = await attachable();

  const user = await harness.userFactory.has(first, "edited").create();

  await expect(harness.prisma.post.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({
    editorId: user.id,
  });
});

test("has(rows) resolves the one has-many relation the model pair shares when the name is left out", async () => {
  const { prisma, commentFactory, postFactory } = await factorioHarness();
  const comment = await commentFactory.create();

  const post = await postFactory.has([comment]).create();

  await expect(prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).resolves.toMatchObject({
    postId: post.id,
  });
});

test("has() rejects a relation field the model pair does not share, naming it and the candidates", async () => {
  const { harness, first } = await attachable();

  await expect(harness.userFactory.has([first], "illustrated" as unknown as "posts").create()).rejects.toThrow(
    'The model "user" has no relation field "illustrated" pointing at "post". ' +
      'Relation fields on "user" pointing at "post": "posts", "edited".',
  );
});

// An empty list stands for no model, so the pair the non-empty forms name is out of reach and the
// field is checked against the ones the model declares alone.
test("has([]) rejects a relation field the model does not declare, naming it and the candidates", async () => {
  const { userFactory } = await factorioHarness();

  await expect(userFactory.has([], "illustrated" as unknown as "posts").create()).rejects.toThrow(
    'The model "user" has no relation field "illustrated". Relation fields on "user": "posts", "edited", "memberships".',
  );
});

test("has([]) creates the parent and no record beyond it", async () => {
  const { prisma, userFactory } = await factorioHarness();

  const user = await userFactory.has([], "posts").create();

  expect(user.id).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(0);
});

// Naming the field and leaving it empty would hand Prisma a nested write with nothing to do.
test("a has layer the parent's own create has nothing to connect leaves the relation field unwritten", async () => {
  const harness = await factorioHarness();

  const none = await userCreateData(harness, (userFactory) => userFactory.has([], "posts"));
  const children = await userCreateData(harness, (userFactory) => userFactory.has(harness.postFactory, "posts"));

  expect(Object.keys(none)).toStrictEqual(["email", "name"]);
  expect(Object.keys(children)).toStrictEqual(["email", "name"]);
});

test("has(rows) hands create the relation field as a connect list of the rows' scalars", async () => {
  const { harness, first, second } = await attachable();

  const data = await userCreateData(harness, (userFactory) => userFactory.has([first, second], "posts"));

  expect(data.posts).toStrictEqual({ connect: [first, second] });
});

test("has(rows) loaded with include connects on the rows' scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness();
  const loaded = await postWithComments(harness);
  const { comments, ...scalars } = loaded;

  const data = await userCreateData(harness, (userFactory) => userFactory.has([loaded], "posts"));

  expect(comments).toStrictEqual([]);
  expect(data.posts).toStrictEqual({ connect: [scalars] });
});

test("two has() calls on one relation field both apply", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.userFactory.has([first], "posts").has([second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
});

test("two has() calls naming different relation fields both apply", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.userFactory.has([first], "posts").has([second], "edited").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id]);
  await expect(harness.prisma.post.findMany({ where: { editorId: user.id } })).resolves.toMatchObject([
    { id: second.id },
  ]);
});

test("has() adds to the relation field a state before it left standing", async () => {
  const { harness, first, second } = await attachable();

  const heldFactory = harness.userFactory.state({ posts: { connect: [{ id: first.id }] } });
  const user = await heldFactory.has([second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
});

// The state names the relation field the `has` layer before it gathered children on, so what the
// parent ends up connected to is what the merge left of that field.
async function replacedByAState(
  { harness, second }: Attachable,
  children: readonly Row<TestClient, "post">[] | Factory<TestClient, "post">,
): Promise<number[]> {
  const gatheredFactory = harness.userFactory.has(children, "posts");
  const user = await gatheredFactory.state({ posts: { connect: [{ id: second.id }] } }).create();

  return authoredBy(harness.prisma, user.id);
}

test("a state after has() replaces the relation field, the children it had gatheredFactory dropped", async () => {
  const target = await attachable();

  await expect(replacedByAState(target, [target.first])).resolves.toStrictEqual([target.second.id]);
});

test("create(overrides) replaces the relation field has() filled, the children it had gatheredFactory dropped", async () => {
  const { harness, first, second } = await attachable();

  const gatheredFactory = harness.userFactory.has([first], "posts");
  const user = await gatheredFactory.create({ posts: { connect: [{ id: second.id }] } });

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([second.id]);
});

test("has returns a new factory rather than changing the one it was called on", async () => {
  const { harness, first } = await attachable();

  const authoredFactory = harness.userFactory.has([first], "posts");
  const user = await harness.userFactory.create();

  expect(authoredFactory).not.toBe(harness.userFactory);
  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([]);
});

test("has(factory) creates the children through their own factory and connects them to the parent", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  const user = await userFactory.has(postFactory, "posts").create();

  await expect(authoredBy(prisma, user.id)).resolves.toHaveLength(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The deliberate opposite of `for`, where one parent is shared by the whole batch.
test("has(factory) creates the children per parent record, so every record of a batch draws its own", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  const rows = await userFactory.count(3).has(postFactory.count(2), "posts").create();
  const counted = await Promise.all(rows.map((user) => prisma.post.count({ where: { authorId: user.id } })));

  expect(counted).toStrictEqual([2, 2, 2]);
  await expect(prisma.post.count()).resolves.toBe(6);
});

// A record is evaluated in the same stretch of the loop that creates it, so the order the layers
// report themselves in is the order the records reach the database in.
test("the children of one record are created before the next record, layers in the order called", async () => {
  const { prismaFactorio, postFactory } = await factorioHarness();
  const order: string[] = [];
  const tagged = (tag: string): Factory<TestClient, "comment"> =>
    prismaFactorio.define("comment", {
      definition: ({ uid }) => {
        order.push(tag);
        return { body: uid, post: postFactory };
      },
    });

  const parentFactory = postFactory.state(() => {
    order.push("post");
    return {};
  });
  await parentFactory.count(2).has(tagged("a"), "comments").has(tagged("b"), "comments").create();

  expect(order).toStrictEqual(["post", "a", "b", "post", "a", "b"]);
});

// The state names one of the two relation fields, so the key the layer after it adds is the second
// one the parent's own attributes carry: what the children are created in is call order, not the
// order the keys of that merge happen to fall in.
test("two has() layers on different relation fields create their children in the order called", async () => {
  const { prismaFactorio, userFactory } = await factorioHarness();
  const order: string[] = [];
  const tagged = (tag: string): Factory<TestClient, "post"> =>
    prismaFactorio.define("post", {
      definition: ({ uid }) => {
        order.push(tag);
        return { title: uid, author: userFactory };
      },
    });

  const heldFactory = userFactory.state({ posts: { connect: [] } });
  await heldFactory.has(tagged("edited"), "edited").has(tagged("posts"), "posts").create();

  expect(order).toStrictEqual(["edited", "posts"]);
});

test("has(factory) batched to no records at all creates the parent and no child", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  const user = await userFactory.has(postFactory.count(0), "posts").create();

  expect(user.id).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(0);
});

test("a child factory brings its own states and its own relation defaults", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const draftFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: otherUsers(prismaFactorio) }),
    states: { drafted: { title: "draft" } },
  });

  const user = await userFactory.has(draftFactory.drafted(), "edited").create();

  await expect(prisma.post.findMany({ where: { editorId: user.id } })).resolves.toMatchObject([{ title: "draft" }]);
  await expect(prisma.user.findMany({ orderBy: { id: "asc" } })).resolves.toMatchObject([
    { name: "Ada" },
    { name: "Hedy" },
  ]);
});

test("a child factory's own has() reaches the level below it", async () => {
  const { prisma, commentFactory, postFactory, userFactory } = await factorioHarness();

  const user = await userFactory.has(postFactory.has(commentFactory, "comments"), "posts").create();
  const [post] = await prisma.post.findMany({ where: { authorId: user.id } });

  await expect(prisma.comment.count({ where: { postId: post?.id ?? 0 } })).resolves.toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// `parent` spans every model the client carries, and the join model declares no `id` of its own, so
// a closure reading one narrows before it reaches the column.
function parentId(parent: Row<TestClient, ModelName<TestClient>> | undefined): number | undefined {
  return parent !== undefined && "id" in parent ? parent.id : undefined;
}

test("a child state closure reads the created parent row through parent", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const creditedFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: { credited: ({ parent }) => ({ title: `by ${String(parentId(parent))}` }) },
  });

  const user = await userFactory.has(creditedFactory.credited(), "posts").create();

  await expect(prisma.post.findMany()).resolves.toMatchObject([{ title: `by ${String(user.id)}` }]);
});

// The row is handed over by deriving a chain of its own, so the factory the caller holds is the one
// they declared: a record it goes on to create for no one reads the record of a run already over.
test("a child factory reused after a has() chain reads no parent of its own", async () => {
  const { prisma, prismaFactorio, userFactory } = await factorioHarness();
  const seen: (number | undefined)[] = [];
  const creditedFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: {
      recorded: ({ parent }) => {
        seen.push(parentId(parent));
        return {};
      },
    },
  });

  // One factory across both calls, naming the client it runs on: a fresh factory would carry a chain
  // of its own with nothing to go stale, and one the run rebinds would be shielded by that rebinding.
  const recordedFactory = creditedFactory.recorded().using(prisma);
  await userFactory.has(recordedFactory, "posts").create();
  await recordedFactory.create();

  expect(seen).toStrictEqual([expect.any(Number), undefined]);
});

// A user and a post are created first, so the two rows the graph then draws carry different ids and
// the one the grandchild names is the record above it rather than the record it shares an id with.
test("a grandchild reads the record just above it through parent, not the top of the chain", async () => {
  const { prisma, prismaFactorio, postFactory, userFactory } = await factorioHarness();
  const creditedFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
    states: { credited: ({ parent }) => ({ body: `for ${String(parentId(parent))}` }) },
  });
  await userFactory.create();

  const user = await userFactory.has(postFactory.has(creditedFactory.credited(), "comments"), "posts").create();
  const [post] = await prisma.post.findMany({ where: { authorId: user.id } });

  expect(post?.id).not.toBe(user.id);
  await expect(prisma.comment.findMany()).resolves.toMatchObject([{ body: `for ${String(post?.id)}` }]);
});

test("two create() calls on one has() chain build the same graph each time", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const authoredFactory = userFactory.has(postFactory.count(2), "posts");

  const first = await authoredFactory.create();
  const second = await authoredFactory.create();

  await expect(authoredBy(prisma, first.id)).resolves.toHaveLength(2);
  await expect(authoredBy(prisma, second.id)).resolves.toHaveLength(2);
  await expect(prisma.post.count()).resolves.toBe(4);
});

test("a layer replacing the relation field drops the child factory, which is never evaluated", async () => {
  const target = await attachable();

  await expect(replacedByAState(target, target.harness.postFactory)).resolves.toStrictEqual([target.second.id]);
  await expect(target.harness.prisma.post.count()).resolves.toBe(2);
});

// The rows reach the parent's own create and the factory's records are created after it, so a field
// carrying both forms is where the two halves of `has` have to agree.
test("a has() layer of rows and one of a factory on one relation field both apply", async () => {
  const { harness, first } = await attachable();

  const user = await harness.userFactory.has([first], "posts").has(harness.postFactory, "posts").create();
  const authored = await authoredBy(harness.prisma, user.id);

  expect(authored).toHaveLength(2);
  expect(authored).toContain(first.id);
});

test("has(factory) creates the children through the client using() named, so a rollback drops them", async () => {
  await withoutOrphans(({ postFactory, userFactory }, tx) => userFactory.has(postFactory, "posts").using(tx).create());
});

test("a child factory naming a client of its own is created through it, not the resolving one", async () => {
  await throughItsOwnClient("post", ({ postFactory, userFactory }, own, tx) =>
    userFactory.has(postFactory.using(own), "posts").using(tx).create(),
  );
});

// A child factory is handed its parent row and its client both, and the two are read off the same
// chain: a level taking one of them from the wrong place still creates the record, on the client the
// factory was declared under, where nothing rolls it back.
test("a nested has() creates the level below the children on that client too", async () => {
  await withoutOrphans(
    ({ commentFactory, postFactory, userFactory }, tx) =>
      userFactory.has(postFactory.has(commentFactory, "comments"), "posts").using(tx).create(),
    [1, 1, 1],
  );
});

test("a has() graph reached through a relation default creates its children on that client", async () => {
  await withoutOrphans(
    ({ prismaFactorio, postFactory, userFactory }, tx) =>
      prismaFactorio
        .define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory.has(postFactory, "posts") }) })
        .using(tx)
        .create(),
    [1, 2, 0],
  );
});

test("a has() factory standing as a for() parent creates its children on that client", async () => {
  await withoutOrphans(
    ({ postFactory, userFactory }, tx) =>
      postFactory.for(userFactory.has(postFactory, "posts"), "author").using(tx).create(),
    [1, 2, 0],
  );
});

// Mocked to throw rather than merely counted: a pass says the lookup was never reached, which is what
// the escape hatch is for on a client whose metadata cannot answer it.
function lookupThatThrows(): MockedFunction<typeof inverseRelationField> {
  const lookup = vi.mocked(inverseRelationField);

  lookup.mockClear();
  lookup.mockImplementation(() => {
    throw new TypeError("the inverse was looked up");
  });
  onTestFinished(() => {
    lookup.mockRestore();
  });

  return lookup;
}

test("the inverse option names the child's relation field, the lookup never reached", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();
  const lookup = lookupThatThrows();

  const user = await userFactory.has(postFactory, "posts", { inverse: "author" }).create();

  await expect(authoredBy(prisma, user.id)).resolves.toHaveLength(1);
  expect(lookup).not.toHaveBeenCalled();
});

// The post/comment pair shares exactly one has-many relation, which is the pair whose type leaves the
// relation field skippable and so the only one reaching these two arities at all.
async function commentedWithoutTheLookup(attach: (harness: Harness) => Factory<TestClient, "post">): Promise<void> {
  const harness = await factorioHarness();
  const lookup = lookupThatThrows();

  const post = await attach(harness).create();

  await expect(harness.prisma.comment.count({ where: { postId: post.id } })).resolves.toBe(1);
  expect(lookup).not.toHaveBeenCalled();
}

test("the options stand alone where the relation field may be left out, the lookup never reached", async () => {
  await commentedWithoutTheLookup(({ commentFactory, postFactory }) =>
    postFactory.has(commentFactory, { inverse: "post" }),
  );
});

// The cast is what `exactOptionalPropertyTypes` costs: this package compiles under it, so the slot a
// skippable relation field leaves takes no explicit `undefined` here. A caller compiling without it —
// the default — or compiling nothing at all reaches this call as written.
test("a relation field passed as undefined leaves the options at the tail, the lookup never reached", async () => {
  await commentedWithoutTheLookup(({ commentFactory, postFactory }) =>
    postFactory.has(commentFactory, undefined as unknown as "comments", { inverse: "post" }),
  );
});

// The three messages the lookup itself throws all point at this option, so a name mistyped in it has
// to answer as a library error rather than as a Prisma invocation the caller cannot place.
test("the inverse option rejects a name that is no relation field of the child pointing at the parent", async () => {
  const { postFactory, userFactory } = await factorioHarness();

  for (const inverse of ["writer", "title"]) {
    await expect(userFactory.has(postFactory, "posts", { inverse }).create()).rejects.toThrow(
      `The model "post" has no relation field "${inverse}" pointing at "user". ` +
        'Relation fields on "post" pointing at "user": "author", "editor".',
    );
  }
});

test("the inverse option is checked before the parent record is written", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  await expect(userFactory.has(postFactory, "posts", { inverse: "writer" }).create()).rejects.toThrow(TypeError);
  await expect(prisma.user.count()).resolves.toBe(0);
});

// What the client hands the inverse lookup, of which the pairing alone is under test here.
interface Pairing {
  models: Record<string, { fields: { name: string; relationName?: string | undefined }[] }>;
}

// The scratch schema pairs every relation field it declares, so a client whose metadata leaves the
// lookup nothing to answer with is built off the real one: the delegates stay where they are and a
// single field loses its pairing.
function unpaired(prisma: TestClient, tag: string, field: string): TestClient {
  const held = (prisma as unknown as { _runtimeDataModel: Pairing })._runtimeDataModel;
  const models = Object.fromEntries(
    Object.entries(held.models).map(([name, model]) => [
      name,
      name !== tag
        ? model
        : {
            ...model,
            fields: model.fields.map((candidate) =>
              candidate.name === field ? { ...candidate, relationName: undefined } : candidate,
            ),
          },
    ]),
  );

  return Object.defineProperty(Object.create(prisma) as TestClient, "_runtimeDataModel", {
    value: { ...held, models },
  });
}

// Both routes to a pending child reach the same lookup, on a client that cannot answer it: what tells
// them apart is the call the throw steers to.
async function withoutPairing(
  attach: (postFactory: Factory<TestClient, "post">, children: ChildComments) => Factory<TestClient, "post", unknown>,
): Promise<Factory<TestClient, "post", unknown>> {
  const harness = await factorioHarness();

  return attach(harness.postFactory, harness.commentFactory).using(unpaired(harness.prisma, "Post", "comments"));
}

const unreadablePairing =
  'The relation field "comments" on the model "post" carries no metadata pairing it with a relation field on "comment". ';

const commentFields = 'Relation fields on "comment": "post".';

test("a has() layer whose inverse cannot be read steers to the option that names it", async () => {
  const postFactory = await withoutPairing((postFactory, commentFactory) =>
    postFactory.has(commentFactory, "comments"),
  );

  await expect(postFactory.create()).rejects.toThrow(
    unreadablePairing + 'Pass the inverse relation field as the "inverse" option of has(). ' + commentFields,
  );
});

// A relation default carries no options to name the inverse through, so the throw steers to the call
// that does rather than to an option this route never reaches.
test("a to-many default whose inverse cannot be read steers to has() instead", async () => {
  const postFactory = await withoutPairing((postFactory, commentFactory) =>
    postFactory.state({ comments: commentFactory }),
  );

  await expect(postFactory.create()).rejects.toThrow(
    unreadablePairing +
      "A relation default takes no options: attach the children with has(children, field, { inverse }) instead. " +
      commentFields,
  );
});

// An implicit many-to-many holds many records at both ends, so `has` reaches it from either one and
// the relation field is skippable on both. The join table Prisma keeps hidden carries no model of its
// own, which is why none of this needs machinery beyond what a one-to-many already uses.
test("has(factory) joins the children to the parent across an implicit many-to-many", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness();

  const post = await postFactory.has(tagFactory.count(3)).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(joined.tags).toHaveLength(3);
  await expect(prisma.tag.count()).resolves.toBe(3);
});

test("has(factory) reaches a many-to-many from the far end just as well", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness();

  const tag = await tagFactory.has(postFactory.count(2)).create();
  const joined = await prisma.tag.findUniqueOrThrow({ where: { id: tag.id }, include: { posts: true } });

  expect(joined.posts).toHaveLength(2);
});

test("has(rows) attaches records that already exist across a many-to-many, creating none", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness();
  const existing = await tagFactory.count(2).create();

  const post = await postFactory.has(existing).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(new Set(joined.tags.map((tag) => tag.id))).toStrictEqual(new Set(existing.map((tag) => tag.id)));
  await expect(prisma.tag.count()).resolves.toBe(2);
});

test("a many-to-many draws its children per parent record, the cadence every has() layer keeps", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness();

  await postFactory.count(3).has(tagFactory.count(2)).create();
  const joined = await prisma.post.findMany({ include: { tags: true } });

  expect(joined.map((post) => post.tags.length)).toStrictEqual([2, 2, 2]);
  await expect(prisma.tag.count()).resolves.toBe(6);
});

// An explicit many-to-many is composition rather than a method of its own: the datamodel holds no
// relation between the two far models, so the join model's factory is what stands between them, and
// its pivot columns are ordinary typed attributes a state reaches like any other.
test("has(joinModel) composes an explicit many-to-many, the placeholder parent never evaluated", async () => {
  const { prisma, userFactory, membershipFactory } = await factorioHarness();

  const ada = await userFactory.has(membershipFactory.count(2).state({ role: "admin" }), "memberships").create();
  const joined = await prisma.membership.findMany({ where: { userId: ada.id } });

  expect(joined.map((membership) => membership.role)).toStrictEqual(["admin", "admin"]);
  expect(new Set(joined.map((membership) => membership.teamId)).size).toBe(2);
  await expect(prisma.team.count()).resolves.toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("the join model's relation field may be left out, the pair sharing exactly one", async () => {
  const { prisma, userFactory, membershipFactory } = await factorioHarness();

  const ada = await userFactory.has(membershipFactory.count(2)).create();

  await expect(prisma.membership.count({ where: { userId: ada.id } })).resolves.toBe(2);
});

// The join model reached as a relation default rather than as a `has` layer: its records are created
// once the parent row exists, so each carries the compound key whole and the leg the parent stands in
// replaces the factory the definition names there, leaving no user behind.
test("a batched factory in the join model's relation field creates its records for the parent", async () => {
  const { prisma, userFactory, membershipFactory } = await factorioHarness();

  const ada = await userFactory.create({ memberships: membershipFactory.count(2) });
  const held = await prisma.membership.findMany({ where: { userId: ada.id } });

  expect(held).toHaveLength(2);
  expect(new Set(held.map((row) => row.teamId)).size).toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("for() names a leg of the join model, each record bringing the far side of its own", async () => {
  const { prisma, userFactory, membershipFactory } = await factorioHarness();
  const ada = await userFactory.create();

  await membershipFactory.count(2).for(ada).create();

  await expect(prisma.membership.count({ where: { userId: ada.id } })).resolves.toBe(2);
  await expect(prisma.team.count()).resolves.toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a state pins an existing row into a leg of the join model rather than drawing a new one", async () => {
  const { prisma, userFactory, teamFactory, membershipFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const team = await teamFactory.create();

  const membership = await membershipFactory.for(ada).state({ team }).create();

  expect(membership.teamId).toBe(team.id);
  await expect(prisma.team.count()).resolves.toBe(1);
});

interface Joined {
  harness: Harness;
  membership: Row<TestClient, "membership">;
}

// A join-model record already written, which is where every route to connecting one starts: handed to
// a `has` layer outright, or drawn from a pool.
async function joined(): Promise<Joined> {
  const harness = await factorioHarness();
  const ada = await harness.userFactory.create();

  return { harness, membership: await harness.membershipFactory.for(ada).create() };
}

// The join model's only unique constraint is its compound key, which Prisma demands under the single
// generated name `userId_teamId`: the flat scalars a row carries satisfy no `WhereUniqueInput`, so
// the where-clause carries the compound selector read off the schema text the client holds.
// Connecting re-homes the row — the membership keeps its team and role, and its user becomes the
// created record.
test("connecting an existing join-model row matches on its compound key", async () => {
  const { harness, membership } = await joined();

  const grace = await harness.userFactory.has([membership], "memberships").create();

  await expect(harness.prisma.membership.findMany()).resolves.toStrictEqual([{ ...membership, userId: grace.id }]);
});

// The same compound key reached through the relation field itself rather than through a `has` layer:
// a list of rows connects through `targetWhere` either way, and neither route stands in for the other.
test("a list of existing join-model rows in a relation field connects on the compound key", async () => {
  const { harness, membership } = await joined();

  const grace = await harness.userFactory.create({ memberships: [membership] });

  await expect(harness.prisma.membership.findMany()).resolves.toStrictEqual([{ ...membership, userId: grace.id }]);
});

// The same compound key reached by a single row rather than a list of them: a row standing alone
// lands in `connect` as a bare object, which Prisma's list form accepts only once the selector
// satisfies the element type.
test("an existing join-model row standing in a relation field connects on the compound key", async () => {
  const { harness, membership } = await joined();

  const grace = await harness.userFactory.create({ memberships: membership });

  await expect(harness.prisma.membership.findMany()).resolves.toStrictEqual([{ ...membership, userId: grace.id }]);
});

// A factory standing in a relation field holding a single record creates its row first, and the
// created row matches back on the compound selector exactly as a handed one does — `badge.membership`
// is the one field the scratch schema reaches a compound-keyed model through bare, no `has` layer
// and no list.
test("a relation default creating a compound-keyed row connects it on its compound key", async () => {
  const { prisma, badgeFactory } = await factorioHarness();

  const badge = await badgeFactory.create();
  const memberships = await prisma.membership.findMany();

  expect(memberships).toHaveLength(1);
  expect([badge.userId, badge.teamId]).toStrictEqual([memberships[0]?.userId, memberships[0]?.teamId]);
});

// The same single-record field filled from a pool: the pick lands in `connect` rather than the
// membership factory running, and matches on the selector alike.
test("a pooled join-model row fills a single-record field on its compound key", async () => {
  const { harness, membership } = await joined();

  const badge = await harness.badgeFactory.recycle("membership", membership).create();

  expect([badge.userId, badge.teamId]).toStrictEqual([membership.userId, membership.teamId]);
  await expect(harness.prisma.membership.count()).resolves.toBe(1);
});

// Pending children reach back to the row that now exists through the same where-clause: badges hung
// off a membership by a `has` layer name it on the compound selector.
test("has() children of a compound-keyed parent reach back on its compound key", async () => {
  const { prisma, membershipFactory, badgeFactory } = await factorioHarness();

  const membership = await membershipFactory.has(badgeFactory.count(2), "badges").create();
  const badges = await prisma.badge.findMany({
    where: { userId: membership.userId, teamId: membership.teamId },
  });

  expect(badges).toHaveLength(2);
  await expect(prisma.membership.count()).resolves.toBe(1);
});

// The schema being enforced, not the library misbehaving: one user belongs to one team once.
test("two join-model records of the same pair collide on the compound key", async () => {
  const { userFactory, teamFactory, membershipFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const team = await teamFactory.create();

  await expect(membershipFactory.count(2).for(ada).state({ team }).create()).rejects.toThrow(
    "Unique constraint failed on the fields: (`userId`, `teamId`)",
  );
});

test("recycle() hands back a factory of its own rather than the receiver", async () => {
  const { userFactory } = await factorioHarness();
  const ada = await userFactory.create();

  expect(userFactory.recycle("user", ada)).not.toBe(userFactory);
});

// An empty pool stands for a model that was never recycled, so the call is legal and changes nothing
// — the same reading `has` gives a list of no children.
test("recycle() pooling no rows leaves a factory that creates exactly as it did", async () => {
  const { prisma, userFactory } = await factorioHarness();

  const user = await userFactory.recycle("user", []).create();

  expect(user.name).toBe("Ada");
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The harness's own post factory names an author alone, and one pooled row filling two slots of one
// model is what tells a pick from a record drawn fresh for each. Local to these tests: widening the
// harness would move the row counts every other suite in this file asserts.
async function editedPosts(options: FactorioOptions = {}): Promise<Harness> {
  const harness = await factorioHarness(options);
  const { prismaFactorio, userFactory } = harness;
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory, editor: userFactory }),
  });
  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
  });

  return { ...harness, postFactory, commentFactory };
}

interface Pooling {
  harness: Harness;
  postFactory: Factory<TestClient, "post">;
  commentFactory: Factory<TestClient, "comment">;
  ada: Row<TestClient, "user">;
}

// One user already written and a graph pooling it, which is where every precedence case starts.
async function pooling(options: FactorioOptions = {}): Promise<Pooling> {
  const harness = await editedPosts(options);
  const ada = await harness.userFactory.create();

  return {
    harness,
    postFactory: harness.postFactory.recycle("user", ada),
    commentFactory: harness.commentFactory.recycle("user", ada),
    ada,
  };
}

async function postBehind({ prisma }: Harness, comment: Row<TestClient, "comment">): Promise<Row<TestClient, "post">> {
  return prisma.post.findUniqueOrThrow({ where: { id: comment.postId } });
}

// The two user slots a post fills, trailed by every user row the graph left behind: a pick connects a
// row already written, a create adds one.
async function slotsAndUsers({ prisma }: Harness, post: Row<TestClient, "post">): Promise<(number | null)[]> {
  return [post.authorId, post.editorId, await prisma.user.count()];
}

test("a pooled row fills every slot of its model the graph reaches, however deep, creating none", async () => {
  const { harness, commentFactory, ada } = await pooling();

  const comment = await commentFactory.create();

  await expect(slotsAndUsers(harness, await postBehind(harness, comment))).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("the same graph pooling nothing draws a record of its own per slot", async () => {
  const harness = await editedPosts();

  const comment = await harness.commentFactory.create();
  const [author, editor, written] = await slotsAndUsers(harness, await postBehind(harness, comment));

  expect(author).not.toBe(editor);
  expect(written).toBe(2);
});

// A caller pools rows it loaded itself, and an `include`d relation is no field to match a record on.
test("a pooled row loaded with include connects on its scalars, the loaded relation left out", async () => {
  const harness = await editedPosts();
  const ada = await userWithPosts(harness);

  const post = await harness.postFactory.recycle("user", ada).create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("recycle(model, []) leaves the graph creating the related records it always did", async () => {
  const { prisma, postFactory } = await editedPosts();

  await postFactory.recycle("user", []).create();

  await expect(prisma.user.count()).resolves.toBe(2);
});

// The pool stands for the related records a graph reaches, which the record a create was called for
// is not: a factory pooling rows of its own model creates all the same.
test("the model a factory creates is never drawn from its own pool", async () => {
  const { prisma, commentFactory } = await factorioHarness();
  const first = await commentFactory.create();

  const second = await commentFactory.recycle("comment", first).create();

  expect(second.id).not.toBe(first.id);
  await expect(prisma.comment.count()).resolves.toBe(2);
});

// A slot the call named outright creates a record of its own — the second user row of the graph —
// and the slot it left alone is drawn from the pool all the same.
async function createdThenDrawn(
  harness: Harness,
  post: Row<TestClient, "post">,
  pooled: Row<TestClient, "user">,
): Promise<void> {
  const [author, editor, written] = await slotsAndUsers(harness, post);

  expect(author).not.toBe(pooled.id);
  expect([editor, written]).toStrictEqual([pooled.id, 2]);
}

test("for(factory) beats the pool, which still fills the slots the call left alone", async () => {
  const { harness, postFactory, ada } = await pooling();

  const post = await postFactory.for(harness.userFactory, "author").create();

  await createdThenDrawn(harness, post, ada);
});

test("an override holding a factory beats the pool, which still fills the slots it left alone", async () => {
  const { harness, postFactory, ada } = await pooling();

  const post = await postFactory.create({ author: harness.userFactory });

  await createdThenDrawn(harness, post, ada);
});

interface NativeAuthored {
  harness: Harness;
  postFactory: Factory<TestClient, "post", Row<TestClient, "post">, { credited: unknown }>;
  ada: Row<TestClient, "user">;
}

// A graph pooling one user over a definition whose author slot is native input creating a user of its
// own: a state naming a factory of the pooled model replaces that input, so a second user row is what
// tells a state that took from one that never ran.
async function nativeAuthored(): Promise<NativeAuthored> {
  const harness = await factorioHarness();
  const { prismaFactorio, userFactory } = harness;
  const ada = await userFactory.create();
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { create: { email: `${uid}@example.com` } }, editor: userFactory }),
    states: { credited: { author: userFactory } },
  });

  return { harness, postFactory: postFactory.recycle("user", ada), ada };
}

test("a factory a declared state names loses to the pool, exactly as a definition default does", async () => {
  const { harness, postFactory, ada } = await nativeAuthored();

  const post = await postFactory.credited().create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("a factory an inline state names loses to the pool too", async () => {
  const { harness, postFactory, ada } = await nativeAuthored();

  const post = await postFactory.state({ author: harness.userFactory }).create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

// Prisma's own relation input is no factory, and the pool stands in for factories alone: the author
// this definition names is created where a factory in that slot would have been drawn.
test("native relation input under a pool creates the record it names, the slots around it drawn", async () => {
  const { harness, postFactory, ada } = await nativeAuthored();

  const post = await postFactory.create();

  await createdThenDrawn(harness, post, ada);
});

test("for(row) stands as it always did, a row being no record the pool could stand in for", async () => {
  const { harness, postFactory, ada } = await pooling();
  const grace = await harness.userFactory.create({ name: "Grace" });

  const post = await postFactory.for(grace, "author").create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([grace.id, ada.id, 2]);
});

test("an override holding a row stands as it always did", async () => {
  const { harness, postFactory, ada } = await pooling();
  const grace = await harness.userFactory.create({ name: "Grace" });

  const post = await postFactory.create({ author: grace });

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([grace.id, ada.id, 2]);
});

// Explicitness covers the slot it was named for and nothing under it: the one post the call names is
// created, and the users that post reaches for are drawn.
async function createdThenDrawnBelow(
  harness: Harness,
  comment: Row<TestClient, "comment">,
  pooled: Row<TestClient, "user">,
): Promise<void> {
  const post = await postBehind(harness, comment);

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([pooled.id, pooled.id, 1]);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
}

test("the pool reaches the graph below a slot the call named outright", async () => {
  const { harness, commentFactory, ada } = await pooling();

  const comment = await commentFactory.for(harness.postFactory, "post").create();

  await createdThenDrawnBelow(harness, comment, ada);
});

test("the pool reaches the graph below an override naming a factory", async () => {
  const { harness, commentFactory, ada } = await pooling();

  const comment = await commentFactory.create({ post: harness.postFactory });

  await createdThenDrawnBelow(harness, comment, ada);
});

test("a has() child factory draws its own relation defaults from the pool", async () => {
  const harness = await editedPosts();
  const { prisma, userFactory, postFactory } = harness;
  const ada = await userFactory.create();

  const author = await userFactory.recycle("user", ada).has(postFactory, "posts").create();
  const post = await prisma.post.findFirstOrThrow({ where: { authorId: author.id } });

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([author.id, ada.id, 2]);
});

// Every slot the graph filled holds a row of the pool: an id the pool never carried — and a slot left
// empty — stands out as an entry of its own.
function strays(picks: readonly (number | null)[], ids: readonly number[]): (number | null)[] {
  return picks.filter((id) => id === null || !ids.includes(id));
}

test("a list pool spreads over every row it holds, calls merged, and picks nothing else", async () => {
  const { prisma, userFactory, postFactory } = await editedPosts({ seed: 7 });
  const pool = await userFactory.count(3).create();
  const ids = pool.map((user) => user.id);

  const rows = await postFactory.count(6).recycle("user", pool.slice(0, 2)).recycle("user", pool.slice(2)).create();
  const picks = rows.flatMap((post) => [post.authorId, post.editorId]);

  expect(strays(picks, ids)).toStrictEqual([]);
  expect(new Set(picks).size).toBe(ids.length);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("a factory pooling rows of its own keeps them when the graph above it hands its pool down", async () => {
  const harness = await editedPosts({ seed: 7 });
  const { prisma, prismaFactorio, userFactory } = harness;
  const ada = await userFactory.create();
  const grace = await userFactory.create({ name: "Grace" });
  const postFactory = harness.postFactory.recycle("user", grace);
  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
  });

  const rows = await commentFactory.count(6).recycle("user", ada).create();
  const drawn = await Promise.all(rows.map((comment) => postBehind(harness, comment)));

  expect(new Set(drawn.flatMap((post) => [post.authorId, post.editorId]))).toStrictEqual(new Set([ada.id, grace.id]));
  await expect(prisma.user.count()).resolves.toBe(2);
});

interface Spread {
  picks: (number | null)[];
  ids: number[];
  written: number;
}

async function spread(seed: number): Promise<Spread> {
  const { prisma, userFactory, postFactory } = await editedPosts({ seed });
  const pool = await userFactory.count(3).create();
  const rows = await postFactory.count(4).recycle("user", pool).create();

  return {
    picks: rows.flatMap((post) => [post.authorId, post.editorId]),
    ids: pool.map((user) => user.id),
    written: await prisma.user.count(),
  };
}

// Each run opens a database of its own, so the ids alone repeat whatever the graph does with them:
// what the pool answers for is that every slot holds a pooled row and no user is written for one.
test("one seed replays the same spread of picks, run for run", async () => {
  const first = await spread(11);
  const second = await spread(11);

  expect(strays(first.picks, first.ids)).toStrictEqual([]);
  expect(first.written).toBe(3);
  expect(first.picks).toStrictEqual(second.picks);
});

test("another seed spreads the picks differently", async () => {
  expect((await spread(11)).picks).not.toStrictEqual((await spread(12)).picks);
});

// A pool of one is a pool all the same: every slot connects that row, and no record of it is created.
test("a pool of one row connects that row to every record of a batch", async () => {
  const { harness, postFactory, ada } = await pooling();

  const rows = await postFactory.count(2).create();

  expect(rows.flatMap((post) => [post.authorId, post.editorId])).toStrictEqual([ada.id, ada.id, ada.id, ada.id]);
  await expect(harness.prisma.user.count()).resolves.toBe(1);
});

// Nothing the graph writes joins the pool: the authors these records create never turn up in a later
// pick, however many of them exist by the time the next slot is filled.
test("rows the graph creates are never drawn later, the pool standing as it was handed over", async () => {
  const { harness, postFactory, ada } = await pooling();

  const rows = await postFactory.count(4).create({ author: harness.userFactory });

  expect(new Set(rows.map((post) => post.editorId))).toStrictEqual(new Set([ada.id]));
  await expect(harness.prisma.user.count()).resolves.toBe(5);
});

interface Attaching {
  harness: Harness;
  authorFactory: Factory<TestClient, "user">;
  pool: Row<TestClient, "post">[];
  ids: number[];
}

// Posts already written and a user factory recycling them, which is where every `has` case starts.
// The harness's post factory brings an author of its own, so the users standing behind the pool are no
// part of what these tests count.
async function attaching(rows: number): Promise<Attaching> {
  const harness = await factorioHarness({ seed: 7 });
  const pool = await harness.postFactory.count(rows).create();

  return { harness, authorFactory: harness.userFactory.recycle("post", pool), pool, ids: pool.map((post) => post.id) };
}

// A drawn child leaves nothing behind that a created one would not, so what tells the picks apart is
// the connect list the parent's own create was handed: one entry per pick, where a slot that connected
// nothing leaves no relation field to read at all.
function connectedIds(data: Record<string, unknown>, field: string): number[] {
  const held = data[field] as { connect?: { id: number }[] } | undefined;

  return (held?.connect ?? []).map((row) => row.id);
}

// A post factory at either arity, which is what `has` takes and what `count` hands back.
type PostChildren = Factory<TestClient, "post", Row<TestClient, "post"> | Row<TestClient, "post">[]>;

// The post ids each record of a parent batch drew, in the order it drew them.
async function drawnIds({ harness, pool }: Attaching, children: PostChildren): Promise<number[][]> {
  const writes = await userWrites(harness, (userFactory) => userFactory.recycle("post", pool).has(children, "posts"));

  return writes.map((data) => connectedIds(data, "posts"));
}

test("has(factory) over a pooled model connects a pooled row rather than creating a record", async () => {
  const { harness, authorFactory, ids } = await attaching(1);

  const author = await authorFactory.has(harness.postFactory, "posts").create();

  await expect(authoredBy(harness.prisma, author.id)).resolves.toStrictEqual(ids);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// The picks a batch of children made over a pool of posts: every one of them a row the pool holds,
// and the pool left exactly as many rows as it was handed.
async function drawnOver(rows: number, children: number): Promise<number[]> {
  const target = await attaching(rows);
  const picks = (await drawnIds(target, target.harness.postFactory.count(children))).flat();

  expect(strays(picks, target.ids)).toStrictEqual([]);
  await expect(target.harness.prisma.post.count()).resolves.toBe(rows);

  return picks;
}

// The batch size the child's own chain carries is what the pool answers for, record for record: a
// layer collapsing it to one pick would connect a third of the children it was asked for.
test("has(factory.count(3)) over a pooled model draws a row per record rather than one for the batch", async () => {
  expect(await drawnOver(3, 3)).toHaveLength(3);
});

// Picks are drawn with replacement, so a pool holding fewer rows than the batch asks for is legal and
// hands the same row out twice rather than running dry — there is no distinctness to rely on.
test("a pool of two rows fills a batch of three, the rows it holds repeating", async () => {
  const picks = await drawnOver(2, 3);

  expect(picks).toHaveLength(3);
  expect(new Set(picks).size).toBeLessThan(picks.length);
});

type ChildTags = Factory<TestClient, "tag", Row<TestClient, "tag">[]>;

interface PerRecord {
  connected: number[][];
  drawn: number;
  written: number;
}

// The picks a batch of parent records made over a pool of one tag, one entry per pick. The pool holds
// tags because a join table leaves the row it connects untouched, where a connect rewriting a foreign
// key leaves the pooled row stale for the record behind it; a repeated pick then collapses into a
// single join row, so the connect list the parent's own create was handed is what tells one pick from
// two.
async function drawnPerRecord(
  attach: (postFactory: Factory<TestClient, "post">, children: ChildTags) => Factory<TestClient, "post", unknown>,
): Promise<PerRecord> {
  const harness = await factorioHarness();
  const tag = await harness.tagFactory.create();
  const { client, written: writes } = recording(harness.prisma, "post");

  await attach(harness.postFactory.recycle("tag", tag), harness.tagFactory.count(2)).count(2).using(client).create();

  return {
    connected: writes.map((data) => connectedIds(data, "tags")),
    drawn: tag.id,
    written: await harness.prisma.tag.count(),
  };
}

// The cadence every `has` layer keeps: children belong to one parent record, so a batch of parents
// draws a batch of children each.
test("a pooled has() child is drawn per parent record, the whole batch of them", async () => {
  const { connected, drawn, written } = await drawnPerRecord((postFactory, tagFactory) => postFactory.has(tagFactory));

  expect(connected).toStrictEqual([
    [drawn, drawn],
    [drawn, drawn],
  ]);
  expect(written).toBe(1);
});

// A connect into a relation field backed by a required foreign key re-homes the child, rewriting the
// column the pooled copy still carries: the next parent record drawing that row matches it on scalars
// the database no longer holds. The raw error names engine internals, so the failure is retold in the
// pool's own terms, the original standing behind it as the cause. The README paragraph on single-use
// pooling stands or falls with this test.
test("a pooled has() child fails the second parent record in the pool's own terms, its foreign key rewritten by the first", async () => {
  const { harness, authorFactory } = await attaching(1);

  await expect(authorFactory.count(2).has(harness.postFactory, "posts").create()).rejects.toMatchObject({
    message:
      'A pooled row drawn into "posts" on the model "user" no longer matches the database: ' +
      "a connect into a relation field backed by a required foreign key re-homes the record, " +
      "rewriting the column the pooled copy still carries, so a pooled row fills such a relation once. " +
      "Pool one row per parent record, or pass native relation input.",
    cause: expect.objectContaining({ code: "P2018" }),
  });
});

// A relation default draws through the same connect a `has` layer writes, so a stale pooled row fails
// its second parent record in the same terms whichever layer named the children.
test("a pooled to-many default fails the second parent record in the pool's own terms", async () => {
  const { harness, first } = await spare();

  await expect(
    harness.postFactory.count(2).recycle("comment", first).state({ comments: harness.commentFactory }).create(),
  ).rejects.toMatchObject({
    message: expect.stringContaining('A pooled row drawn into "comments" on the model "post"'),
    cause: expect.objectContaining({ code: "P2018" }),
  });
});

// Each create() call wires a pool run of its own, so a row an earlier call drew and re-homed fails a
// later one the same way it fails a batch-mate.
test("a pooled has() child drawn again by a later create() fails in the pool's own terms", async () => {
  const { harness, authorFactory } = await attaching(1);

  await authorFactory.has(harness.postFactory, "posts").create();

  await expect(authorFactory.has(harness.postFactory, "posts").create()).rejects.toMatchObject({
    message: expect.stringContaining('A pooled row drawn into "posts" on the model "user"'),
    cause: expect.objectContaining({ code: "P2018" }),
  });
});

// The pool's terms belong to the pool: a row the caller hands over went stale by the caller's own
// doing, and Prisma's error reaches it unretold.
test("rows the caller hands has() keep Prisma's own error when stale", async () => {
  const { prisma, userFactory, postFactory } = await factorioHarness();
  const ada = await userFactory.create();
  const post = await postFactory.create({ author: ada });
  await userFactory.has([post], "posts").create();

  await expect(userFactory.has([post], "posts").create()).rejects.toMatchObject({ code: "P2018" });
  await expect(prisma.user.count()).resolves.toBe(2);
});

// A caller pools rows it loaded itself, and an `include`d relation is no field to match a record on.
test("a pooled has() child loaded with include connects on its scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness({ seed: 7 });
  const loaded = await postWithComments(harness);
  const { comments, ...scalars } = loaded;

  const data = await userCreateData(harness, (userFactory) =>
    userFactory.recycle("post", loaded).has(harness.postFactory, "posts"),
  );

  expect(comments).toStrictEqual([]);
  expect(data.posts).toStrictEqual({ connect: [scalars] });
});

// A chain batched to no records asks the pool for nothing, and a relation field with nothing to
// connect stays unwritten — the same reading `has` gives a list of no children.
test("has(factory.count(0)) over a pooled model draws nothing and leaves the relation field unwritten", async () => {
  const { harness, pool } = await attaching(1);

  const data = await userCreateData(harness, (userFactory) =>
    userFactory.recycle("post", pool).has(harness.postFactory.count(0), "posts"),
  );

  expect(Object.keys(data)).toStrictEqual(["email", "name"]);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// A drawn child stands for a record that exists already, so the factory naming it never runs — no
// definition of its own, and no state either.
test("a pooled has() child factory is never evaluated", async () => {
  const { harness, authorFactory, pool } = await attaching(1);
  const evaluated: string[] = [];
  const postFactory = harness.prismaFactorio.define("post", {
    definition: ({ uid }) => {
      evaluated.push(uid);
      return { title: uid, author: harness.userFactory };
    },
  });

  const author = await authorFactory.has(postFactory, "posts").create();

  expect(evaluated).toStrictEqual([]);
  await expect(authoredBy(harness.prisma, author.id)).resolves.toStrictEqual(pool.map((post) => post.id));
});

// Both ends of an implicit many-to-many hold many records, so a pooled child reaches it through the
// same `has` layer a created one does, and the picks land in one join table row each.
test("a pooled has() child joins the parent across an implicit many-to-many", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness({ seed: 7 });
  const tag = await tagFactory.create();

  const post = await postFactory.recycle("tag", tag).has(tagFactory.count(2)).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(joined.tags.map((row) => row.id)).toStrictEqual([tag.id]);
  await expect(prisma.tag.count()).resolves.toBe(1);
});

// A drawn row lands in the parent's own create, which is a call site of its own: the same compound
// selector reaches it there, so a pooled join-model row connects exactly as one the caller hands
// `has`, and no membership is created for the drawn slot.
test("a pooled join-model row connects on its compound key, drawn into the parent's own create", async () => {
  const { harness, membership } = await joined();

  const grace = await harness.userFactory.recycle("membership", membership).has(harness.membershipFactory).create();

  await expect(harness.prisma.membership.findMany()).resolves.toStrictEqual([{ ...membership, userId: grace.id }]);
});

// What the post's own create was handed under `comments`, one entry per record of the batch, alongside
// what the post holds once the graph is done, every comment standing by then and the row the pool was
// handed. A drawn child leaves nothing behind that a created one would not, and a pool of one hands
// that row out every time, so the connect list is what tells one pick from two where the database tells
// whether the picks landed on the post at all.
interface Drawn {
  attached: number[];
  connected: number[][];
  keys: string[][];
  written: number;
  drawn: number;
}

// Where the slot is filled is all these cases differ by: the pool, the children and the client the
// writes are recorded through stand the same throughout, so what the picks answer to is the layer the
// post factory arrives back through.
async function pooledChildren(
  records: number,
  attach: (harness: Harness, children: ChildComments) => Factory<TestClient, "post", unknown>,
): Promise<Drawn> {
  const { harness, first } = await spare();
  const { client, written: writes } = recording(harness.prisma, "post");

  const post = (await attach(harness, harness.commentFactory.count(records))
    .recycle("comment", first)
    .using(client)
    .create()) as Row<TestClient, "post">;

  return {
    attached: await attachedTo(harness.prisma, post.id, "comments"),
    connected: writes.map((data) => connectedIds(data, "comments")),
    keys: writes.map((data) => Object.keys(data)),
    written: await harness.prisma.comment.count(),
    drawn: first.id,
  };
}

// The batch size the child's own chain carries is what the pool answers for, record for record: a layer
// collapsing it to one pick would connect half the children the slot was asked for.
test("a to-many default a state names loses to the pool, one pick per record it would have created", async () => {
  const { attached, connected, written, drawn } = await pooledChildren(2, (harness, commentFactory) =>
    harness.postFactory.state({ comments: commentFactory }),
  );

  expect(connected).toStrictEqual([[drawn, drawn]]);
  expect(attached).toStrictEqual([drawn]);
  expect(written).toBe(2);
});

// Each pick answers one record the slot would have created, whichever layer the default arrived by.
async function poolBeatsDefault(
  attach: (harness: Harness, children: ChildComments) => Factory<TestClient, "post", unknown>,
): Promise<void> {
  const { connected, written, drawn } = await pooledChildren(2, attach);

  expect(connected).toStrictEqual([[drawn, drawn]]);
  expect(written).toBe(2);
}

test("a to-many default a definition names loses to the pool the same way", async () => {
  await poolBeatsDefault(({ prismaFactorio, userFactory }, commentFactory) =>
    prismaFactorio.define("post", {
      definition: ({ uid }) => ({ title: uid, author: userFactory, comments: commentFactory }),
    }),
  );
});

// A state is a state wherever it was declared: the pool beats the one the config names exactly as it
// beats the one a call adds.
test("a to-many default a config-declared state names loses to the pool too", async () => {
  await poolBeatsDefault(({ prismaFactorio, userFactory }, commentFactory) =>
    prismaFactorio
      .define("post", {
        definition: ({ uid }) => ({ title: uid, author: userFactory }),
        states: { commented: { comments: commentFactory } },
      })
      .commented(),
  );
});

test("a to-many default the caller names outright beats the pool and creates its children", async () => {
  const { harness, first } = await spare();

  const post = await harness.postFactory
    .recycle("comment", first)
    .create({ comments: harness.commentFactory.count(2) });
  const held = await attachedTo(harness.prisma, post.id, "comments");

  expect(held).toHaveLength(2);
  expect(held).not.toContain(first.id);
  await expect(harness.prisma.comment.count()).resolves.toBe(4);
});

// A chain batched to no records asks the pool for nothing, and a relation field with nothing to connect
// stays unwritten — the same reading a pooled `has` layer gives a batch of none.
test("a pooled to-many default batched to no records draws nothing and leaves the relation field unwritten", async () => {
  const { keys, written } = await pooledChildren(0, (harness, commentFactory) =>
    harness.postFactory.state({ comments: commentFactory }),
  );

  expect(keys).toStrictEqual([["title", "author"]]);
  expect(written).toBe(2);
});

// The cadence a to-many default keeps, which is `for()`'s deliberate opposite: children belong to one
// record, so every record of a batch draws a set of its own.
test("a pooled to-many default is drawn per parent record, the whole batch of them", async () => {
  const { connected, drawn, written } = await drawnPerRecord((postFactory, tagFactory) =>
    postFactory.state({ tags: tagFactory }),
  );

  expect(connected).toStrictEqual([
    [drawn, drawn],
    [drawn, drawn],
  ]);
  expect(written).toBe(1);
});

// Explicitness covers the slot the call named and nothing under it: the post the override names is
// created rather than drawn, and the editor that post reaches for is drawn all the same.
test("the pool reaches the graph below a to-many default the caller named outright", async () => {
  const { harness, postFactory, ada } = await pooling();
  const standing = await postFactory.create();

  const user = await harness.userFactory
    .recycle("post", standing)
    .recycle("user", ada)
    .create({ posts: harness.postFactory });
  const authored = await harness.prisma.post.findMany({ where: { authorId: user.id } });

  expect(authored.map((post) => post.editorId)).toStrictEqual([ada.id]);
  await expect(harness.prisma.post.count()).resolves.toBe(2);
  await expect(harness.prisma.user.count()).resolves.toBe(2);
});

// Both ends of an implicit many-to-many hold many records, so a to-many default reaches it through the
// same picks a `has` layer draws, and they land in one join table row each.
test("a pooled to-many default joins the parent across an implicit many-to-many", async () => {
  const { prisma, postFactory, tagFactory } = await factorioHarness({ seed: 7 });
  const tag = await tagFactory.create();

  const post = await postFactory
    .recycle("tag", tag)
    .state({ tags: tagFactory.count(2) })
    .create();

  await expect(attachedTo(prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
  await expect(prisma.tag.count()).resolves.toBe(1);
});

// The three ways a graph reaches a record of another model, in one create: the author the definition
// names, the editor a state names, and the tag a `has` layer brings. Every one of them is drawn.
test("the pool fills a definition slot, a state slot and a has() child of one graph alike", async () => {
  const { prisma, userFactory, postFactory, tagFactory } = await factorioHarness({ seed: 7 });
  const ada = await userFactory.create();
  const tag = await tagFactory.create();

  const post = await postFactory
    .recycle("user", ada)
    .recycle("tag", tag)
    .state({ editor: userFactory })
    .has(tagFactory)
    .create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect([post.authorId, post.editorId]).toStrictEqual([ada.id, ada.id]);
  expect(joined.tags.map((row) => row.id)).toStrictEqual([tag.id]);
  await expect(prisma.user.count()).resolves.toBe(1);
  await expect(prisma.tag.count()).resolves.toBe(1);
});

// What a rollback leaves standing: on the target, the rows written before the transaction opened and
// nothing the graph created inside it; on the database the harness bootstrapped, nothing at all.
async function leftBehind(harness: Harness, target: TestClient, standing: Graph): Promise<void> {
  await expect(graphOf(target)).resolves.toStrictEqual(standing);
  await expect(graphOf(harness.prisma)).resolves.toStrictEqual([0, 0, 0]);
}

// The pooled row is written to the target outside the transaction, which is what the graph connects
// to and what stands there afterwards: a row the pool hands over is never the transaction's to drop.
test("using(tx) covers a graph that recycles, and a rollback leaves nothing behind", async () => {
  const harness = await editedPosts();
  const target = await disposableClient();
  const ada = await harness.userFactory.using(target).create();

  await rolledBack(target, (tx) => harness.commentFactory.recycle("user", ada).using(tx).create(), [1, 1, 1]);

  await leftBehind(harness, target, [1, 0, 0]);
});

// A drawn child joins the parent's own create rather than being created after it, so the client that
// create runs on is the one its connect list is resolved against.
test("using(tx) covers a has() layer drawing from the pool, and a rollback drops the parent", async () => {
  const harness = await factorioHarness();
  const target = await disposableClient();
  const post = await harness.postFactory.using(target).create();

  await rolledBack(
    target,
    (tx) => harness.userFactory.recycle("post", post).has(harness.postFactory, "posts").using(tx).create(),
    [2, 1, 0],
  );

  await leftBehind(harness, target, [1, 1, 0]);
});

interface Notified {
  seen: Row<TestClient, "user">[];
  userFactory: Factory<TestClient, "user">;
}

// The rows a config-declared callback was handed, in the order it was handed them.
function notifiedUsers(prismaFactorio: Factorio<TestClient>): Notified {
  const seen: Row<TestClient, "user">[] = [];
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: (user) => {
      seen.push(user);
    },
  });

  return { seen, userFactory };
}

test("a config-declared afterCreating fires with the created row", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { seen, userFactory } = notifiedUsers(prismaFactorio);

  const ada = await userFactory.create();

  expect(seen).toStrictEqual([ada]);
});

test("count(3) fires the callback once per row, each with the row it was created for", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { seen, userFactory } = notifiedUsers(prismaFactorio);

  const rows = await userFactory.count(3).create();

  expect(seen).toStrictEqual(rows);
  expect(seen).toHaveLength(3);
});

test("count(0) creates no record and fires no callback", async () => {
  const { prismaFactorio } = await factorioHarness();
  const { seen, userFactory } = notifiedUsers(prismaFactorio);

  const rows = await userFactory.count(0).create();

  expect(rows).toStrictEqual([]);
  expect(seen).toStrictEqual([]);
});

// A callback records the name it was registered under, which is what every ordering below is read
// off. It takes no arguments, so one serves a factory of any model.
function logging(log: string[], name: string): () => void {
  return () => {
    log.push(name);
  };
}

// Two entries per callback rather than one: started together, the log would read "first in",
// "second in", so only awaiting each before the next begins leaves the pairs unbroken.
function yielding(log: string[], name: string): () => Promise<void> {
  return async () => {
    log.push(`${name} in`);
    await Promise.resolve();
    log.push(`${name} out`);
  };
}

test("a fluent afterCreating fires with the created row", async () => {
  const { userFactory } = await factorioHarness();
  const seen: Row<TestClient, "user">[] = [];

  const ada = await userFactory
    .afterCreating((user) => {
      seen.push(user);
    })
    .create();

  expect(seen).toStrictEqual([ada]);
});

test("a config-declared callback runs before the fluent ones, which run in registration order", async () => {
  const { prismaFactorio } = await factorioHarness();
  const log: string[] = [];
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: logging(log, "config"),
  });

  await userFactory.afterCreating(logging(log, "first")).afterCreating(logging(log, "second")).create();

  expect(log).toStrictEqual(["config", "first", "second"]);
});

test("each callback finishes before the next one starts", async () => {
  const { userFactory } = await factorioHarness();
  const log: string[] = [];

  await userFactory.afterCreating(yielding(log, "first")).afterCreating(yielding(log, "second")).create();

  expect(log).toStrictEqual(["first in", "first out", "second in", "second out"]);
});

test("afterCreating leaves the factory it was called on untouched", async () => {
  const { userFactory } = await factorioHarness();
  const log: string[] = [];
  const notifiedFactory = userFactory.afterCreating(logging(log, "once"));

  await userFactory.create();
  await notifiedFactory.create();

  expect(log).toStrictEqual(["once"]);
});

test("afterCreating keeps the batch and the states, whichever order the chain was written in", async () => {
  const { prismaFactorio } = await factorioHarness();
  const log: string[] = [];
  const userFactory = statefulUsers(prismaFactorio);

  const one = await userFactory.afterCreating(logging(log, "before")).suspended().create();
  const many = await userFactory.count(2).afterCreating(logging(log, "after")).create();

  expect(one.name).toBeNull();
  expect(many).toHaveLength(2);
  expect(log).toStrictEqual(["before", "after", "after"]);
});

function loggingUsers(prismaFactorio: Factorio<TestClient>, log: string[], name: string): Factory<TestClient, "user"> {
  return prismaFactorio.define("user", { definition: userDefinition, afterCreating: logging(log, name) });
}

// A row already standing, which is what a pool hands over: written straight through the client, so no
// factory ran for it and the log is empty before the graph under test does anything.
async function standingUser(prisma: TestClient): Promise<Row<TestClient, "user">> {
  return prisma.user.create({ data: { email: "standing@example.com", name: "Ada" } });
}

test("a parent's callback sees its has() children already written", async () => {
  const { prismaFactorio, postFactory } = await factorioHarness();
  const counted: number[] = [];
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      counted.push(await client.post.count({ where: { authorId: user.id } }));
    },
  });

  await userFactory.has(postFactory.count(2), "posts").create();

  expect(counted).toStrictEqual([2]);
});

// The whole shape in one graph: a parent the definition embeds, two children, and the record between
// them. A child counts the posts standing when its own callback fires, and the record counts the
// children it holds, so the log pins the record as written ahead of the children — a child created
// before it would have brought the post its own definition names, and counted two.
async function firingOrder(
  attach: (postFactory: Factory<TestClient, "post">, children: ChildComments) => Factory<TestClient, "post">,
): Promise<string[]> {
  const { prismaFactorio, postFactory: standing } = await factorioHarness();
  const log: string[] = [];
  const userFactory = loggingUsers(prismaFactorio, log, "parent");
  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: standing }),
    afterCreating: async (comment, { client }) => {
      log.push(`child, ${String(await client.post.count())} postFactory written`);
    },
  });
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    afterCreating: async (post, { client }) => {
      log.push(`record sees ${String(await client.comment.count({ where: { postId: post.id } }))} children`);
    },
  });

  await attach(postFactory, commentFactory.count(2)).create();

  return log;
}

const wholeGraph = ["parent", "child, 1 postFactory written", "child, 1 postFactory written", "record sees 2 children"];

test("a graph fires the parent's callbacks, then each child's own, then the record's last", async () => {
  await expect(firingOrder((postFactory, children) => postFactory.has(children, "comments"))).resolves.toStrictEqual(
    wholeGraph,
  );
});

// A record a to-many default brings runs a `write` of its own, so its callbacks fire exactly where a
// `has` child's do, and the whole graph reads the same either way.
test("a to-many default fires each child's own callbacks between the record and the record's own", async () => {
  await expect(
    firingOrder((postFactory, children) => postFactory.state({ comments: children })),
  ).resolves.toStrictEqual(wholeGraph);
});

// One parent answers the whole batch, so its own create runs once and so do the callbacks behind it.
test("a for() parent's callbacks fire once per create() call rather than once per record", async () => {
  const { prismaFactorio, postFactory } = await factorioHarness();
  const log: string[] = [];
  const userFactory = loggingUsers(prismaFactorio, log, "user");

  const written = await postFactory.count(3).for(userFactory, "author").create();

  expect(written).toHaveLength(3);
  expect(log).toStrictEqual(["user"]);
});

// The second create runs the same graph with no pool: it fires once, which is what shows the first
// create fired none rather than the callback never having been registered.
test("a row drawn from the pool into an embedded slot fires no callback", async () => {
  const { prisma, prismaFactorio } = await factorioHarness();
  const log: string[] = [];
  const userFactory = loggingUsers(prismaFactorio, log, "user");
  const postFactory = prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory }) });
  const ada = await standingUser(prisma);

  await postFactory.recycle("user", ada).create();
  await postFactory.create();

  expect(log).toStrictEqual(["user"]);
});

// The standing post is created through the factory, so the one entry on the log is its own: the two
// records the `has` layer would have created were drawn from the pool instead and fired nothing.
test("a has() child factory drawn from the pool fires no callback", async () => {
  const { prismaFactorio, userFactory } = await factorioHarness();
  const log: string[] = [];
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    afterCreating: logging(log, "post"),
  });
  const standing = await postFactory.create();

  await userFactory.recycle("post", standing).has(postFactory.count(2), "posts").create();

  expect(log).toStrictEqual(["post"]);
});

// The standing comment is created through the factory, so the one entry on the log is its own: the two
// records the to-many default would have created were drawn from the pool instead and fired nothing.
test("a to-many default drawn from the pool fires no callback", async () => {
  const { prismaFactorio, postFactory } = await factorioHarness();
  const log: string[] = [];
  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
    afterCreating: logging(log, "comment"),
  });
  const standing = await commentFactory.create();

  await postFactory
    .recycle("comment", standing)
    .state({ comments: commentFactory.count(2) })
    .create();

  expect(log).toStrictEqual(["comment"]);
});

// `for()` names the caller's own parent, which the pool never stands in for, so that record is created
// like any other and the callbacks behind it run.
test("a for() parent under a pool of its model is still created, and still fires", async () => {
  const { prisma, prismaFactorio, postFactory } = await factorioHarness();
  const log: string[] = [];
  const userFactory = loggingUsers(prismaFactorio, log, "user");
  const ada = await standingUser(prisma);

  await postFactory.recycle("user", ada).for(userFactory, "author").create();

  expect(log).toStrictEqual(["user"]);
  await expect(prisma.user.count()).resolves.toBe(2);
});

test("a throwing callback rejects create(), leaving the record it followed committed", async () => {
  const { prisma, prismaFactorio } = await factorioHarness();
  const failed = new Error("the callback failed");
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: () => {
      throw failed;
    },
  });

  await expect(userFactory.create()).rejects.toBe(failed);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The same throw under a transaction the caller opened, with a write of the callback's own ahead of
// it: nothing catches the throw, so the graph and the row the callback wrote roll back together. The
// count taken inside the transaction is what tells that write from one that never happened.
test("a throwing callback under using(tx) rolls its own writes back along with the graph", async () => {
  const harness = await factorioHarness();
  const target = await disposableClient();
  const failed = new Error("the callback failed");
  const inside: number[] = [];
  const userFactory = harness.prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "audit", author: { connect: { id: user.id } } } });
      inside.push(await client.post.count());
      throw failed;
    },
  });

  const outcome: unknown = await target
    .$transaction((tx) => userFactory.has(harness.postFactory.count(2), "posts").using(tx).create())
    .catch((error: unknown) => error);

  expect(outcome).toBe(failed);
  expect(inside).toStrictEqual([3]);
  await leftBehind(harness, target, [0, 0, 0]);
});

// Bootstrapped on one database and redirected to another: the post reaches the second only because
// the callback wrote through the client handed to it rather than through the one it could close over.
test("a callback writes through the client the chain writes through", async () => {
  const { prisma, prismaFactorio } = await factorioHarness();
  const elsewhere = await disposableClient();
  const userFactory = prismaFactorio.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "welcome", author: { connect: { id: user.id } } } });
    },
  });

  await userFactory.using(elsewhere).create();

  await expect(elsewhere.post.count()).resolves.toBe(1);
  await expect(prisma.post.count()).resolves.toBe(0);
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function recycleCheckedByTheCompiler(
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  userRow: Row<TestClient, "user">,
  statefulFactory: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
): void {
  // Held rather than written inline: a row loaded with `include` carries its relations alongside its
  // scalars, and excess property checking reaches a fresh object literal only.
  const included = { ...userRow, posts: [], edited: [] };

  void userFactory.recycle("user", userRow).create();
  void userFactory.recycle("user", [userRow]).create();
  void userFactory.recycle("user", included).create();
  void postFactory.recycle("user", userRow).recycle("post", []).create();

  expectTypeOf(userFactory.recycle("user", userRow)).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(userFactory.count(2).recycle("user", userRow).create()).resolves.toEqualTypeOf<
    Row<TestClient, "user">[]
  >();
  expectTypeOf(statefulFactory.recycle("user", userRow).suspended()).toEqualTypeOf<typeof statefulFactory>();
  expectTypeOf(statefulFactory.suspended().recycle("user", userRow)).toEqualTypeOf<typeof statefulFactory>();

  // @ts-expect-error a row missing a scalar the named model requires
  void userFactory.recycle("user", { id: 1 });
  // @ts-expect-error a row of a model other than the one named
  void userFactory.recycle("post", userRow);
  // @ts-expect-error a model the client does not carry
  void userFactory.recycle("author", userRow);
  // @ts-expect-error a list holding a value that is no row of the named model
  void userFactory.recycle("user", [userRow, 42]);
}

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function relationsCheckedByTheCompiler(
  postFactory: Factory<TestClient, "post">,
  commentFactory: Factory<TestClient, "comment">,
  userFactory: Factory<TestClient, "user">,
  userRow: Row<TestClient, "user">,
  postRow: Row<TestClient, "post">,
  commentRow: Row<TestClient, "comment">,
  statefulFactory: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
  draftable: Factory<TestClient, "post", Row<TestClient, "post">, { drafted: unknown }>,
  tagFactory: Factory<TestClient, "tag">,
  tagRow: Row<TestClient, "tag">,
  teamFactory: Factory<TestClient, "team">,
  membershipFactory: Factory<TestClient, "membership">,
): void {
  void postFactory.for(userFactory, "author").create();
  void postFactory.for(userRow, "editor").create();
  void postFactory.for(statefulFactory, "author").create();
  void postFactory.for(statefulFactory.suspended(), "author").create();
  void commentFactory.for(postFactory).create();
  void commentFactory.for(postRow).create();

  expectTypeOf(postFactory.for(userFactory, "author")).toEqualTypeOf<Factory<TestClient, "post">>();
  expectTypeOf(postFactory.count(2).for(userFactory, "author").create()).resolves.toEqualTypeOf<
    Row<TestClient, "post">[]
  >();

  // @ts-expect-error the relation field is required where the model pair shares several
  void postFactory.for(userFactory);
  // @ts-expect-error a row infers the model it belongs to, so this pair shares several too
  void postFactory.for(userRow);
  // @ts-expect-error no belongs-to relation reaches a user from a comment
  void commentFactory.for(userFactory, "post");
  // @ts-expect-error no belongs-to relation reaches a user from a comment, name left out
  void commentFactory.for(userFactory);
  // @ts-expect-error the one relation reaching a comment from a post holds many records
  void postFactory.for(commentFactory, "comments");
  // @ts-expect-error a relation field the model pair does not share
  void postFactory.for(userFactory, "illustrator");
  // @ts-expect-error a value that is neither a factory nor a row
  void postFactory.for(42, "author");
  // @ts-expect-error a batched factory creates a row each, so it stands for no one parent
  void postFactory.for(userFactory.count(3), "author");

  void userFactory.has(postFactory, "posts").create();
  void userFactory.has(draftable, "posts").create();
  void userFactory.has(draftable.drafted(), "posts").create();
  void userFactory.has(postFactory.count(3), "edited").create();
  void userFactory.has(postRow, "posts").create();
  void userFactory.has([postRow], "posts").create();
  void postFactory.has(commentFactory).create();
  void postFactory.has(commentRow).create();
  void userFactory.has(postFactory, "posts", { inverse: "author" }).create();
  void postFactory.has(commentFactory, { inverse: "post" }).create();
  // The option is declared as skippable rather than merely optional, so a name held elsewhere reaches
  // the call whether or not it was found.
  void userFactory.has(postFactory, "posts", { inverse: undefined }).create();

  expectTypeOf(userFactory.has(postFactory, "posts")).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(userFactory.count(2).has(postFactory, "posts").create()).resolves.toEqualTypeOf<
    Row<TestClient, "user">[]
  >();

  // @ts-expect-error the relation field is required where the model pair shares several
  void userFactory.has(postFactory);
  // @ts-expect-error a row infers the model it belongs to, so this pair shares several too
  void userFactory.has(postRow);
  // @ts-expect-error the one relation reaching a post from a comment holds one record
  void commentFactory.has(postFactory, "post");
  // @ts-expect-error the one relation reaching a post from a comment holds one record, name left out
  void commentFactory.has(postFactory);
  // @ts-expect-error no relation of any arity reaches a user from a comment
  void commentFactory.has(userFactory);
  // @ts-expect-error the relations reaching a user from a post hold one record each
  void postFactory.has(userFactory, "author");
  // @ts-expect-error a relation field the model pair does not share
  void userFactory.has(postFactory, "illustrated");
  // @ts-expect-error a value that is neither a factory, a row, nor a list of rows
  void userFactory.has(42, "posts");
  // @ts-expect-error an option the escape hatch does not carry
  void userFactory.has(postFactory, "posts", { inverze: "author" });
  // @ts-expect-error the options stand alone only where the relation field may be left out
  void userFactory.has(postFactory, { inverse: "author" });

  void postFactory.has(tagFactory).create();
  void postFactory.has(tagFactory.count(3), "tags").create();
  void postFactory.has([tagRow]).create();
  void tagFactory.has(postFactory).create();
  void tagFactory.has(postFactory.count(2), "posts").create();

  // Both ends of an implicit many-to-many hold many records, so the pair has no belongs-to side at
  // all and `has` is the only way in — from whichever end reads better.
  // @ts-expect-error no belongs-to relation reaches a tag from a post
  void postFactory.for(tagFactory);
  // @ts-expect-error naming the field does not make one, the field being a list at both ends
  void postFactory.for(tagFactory, "tags");
  // @ts-expect-error no belongs-to relation reaches a post from a tag either
  void tagFactory.for(postFactory);
  // @ts-expect-error a row names the same pair, and answers the same way
  void postFactory.for(tagRow);

  void userFactory.has(membershipFactory, "memberships").create();
  void userFactory.has(membershipFactory.count(2)).create();
  void teamFactory.has(membershipFactory).create();
  void membershipFactory.for(userFactory).create();
  void membershipFactory.for(userRow).create();
  void membershipFactory.for(teamFactory).create();

  // The datamodel holds no relation between the two far models of an explicit many-to-many, so the
  // pair answers at neither arity and the join model's factory is the only way across.
  // @ts-expect-error no has-many relation reaches a team from a user
  void userFactory.has(teamFactory);
  // @ts-expect-error no belongs-to relation reaches a team from a user either
  void userFactory.for(teamFactory);
}

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function callbacksCheckedByTheCompiler(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  statefulFactory: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
): void {
  const noted = (): void => undefined;

  void userFactory.afterCreating(noted).create();
  // Whatever a callback hands back is awaited and discarded, so the concise form of an arrow — whose
  // return type is the call's own — stands here as readily as a block body returning nothing.
  void userFactory
    .afterCreating(async (user, { client }) => client.post.count({ where: { authorId: user.id } }))
    .create();
  void prismaFactorio.define("user", { definition: userDefinition, afterCreating: noted });

  expectTypeOf(userFactory.afterCreating(noted)).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(userFactory.count(2).afterCreating(noted).create()).resolves.toEqualTypeOf<Row<TestClient, "user">[]>();
  expectTypeOf(statefulFactory.afterCreating(noted).suspended()).toEqualTypeOf<typeof statefulFactory>();
  expectTypeOf(statefulFactory.suspended().afterCreating(noted)).toEqualTypeOf<typeof statefulFactory>();

  // @ts-expect-error the row is the factory's own model, so a column another model declares is not on it
  void userFactory.afterCreating((user) => user.slug);
  // @ts-expect-error the context carries the client and nothing else
  void userFactory.afterCreating((user, { pool }) => pool);
  // @ts-expect-error a value that is no callback at all
  void userFactory.afterCreating(42);
  // @ts-expect-error the config key takes one callback rather than a list of them
  void prismaFactorio.define("user", { definition: userDefinition, afterCreating: [noted] });
}
