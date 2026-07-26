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
  await statefulUsers(f).using(elsewhere).suspended().create();

  await expect(elsewhere.user.findMany()).resolves.toMatchObject([{ name: null }, { name: null }]);
  await expect(prisma.user.count()).resolves.toBe(0);
});

test("a state closure is handed the definition's context, plus attrs and parent", async () => {
  const { f } = await factorioHarness();
  const seen: unknown[] = [];
  const users = f.define("user", {
    definition: userDefinition,
    states: {
      recorded: (context) => {
        expectTypeOf(context).toEqualTypeOf<StateContext<TestClient, "user">>();
        seen.push(context);
        return {};
      },
    },
  });

  await users.recorded().create();

  expect(seen[0]).toMatchObject({ index: 0, parent: undefined, attrs: { name: "Ada" } });
});

test("a state leaves the row typing of the chain it is applied to untouched", async () => {
  const { f } = await factorioHarness();
  const users = statefulUsers(f);

  const one = await users.suspended().create();
  const many = await users.count(2).suspended().create();

  const inline = await users.state({ name: "Grace" }).create();

  expectTypeOf(one).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(inline).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(many).toEqualTypeOf<Row<TestClient, "user">[]>();
  expect(many.map((row) => row.name)).toStrictEqual([null, null]);
});

test("a state named after a factory method is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take a name the factory already answers to
    f.define("user", { definition: userDefinition, states: { create: { name: "Grace" } } }),
  ).toThrow('The state "create" takes a name a factory reserves. Rename the state.');
});

// A factory carrying a `then` is thenable, so awaiting one — or returning it from an async
// function — would hand the awaiter a state method and never settle.
test("a state named then is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not be named after the thenable protocol
    f.define("user", { definition: userDefinition, states: { then: { name: "Grace" } } }),
  ).toThrow('The state "then" takes a name a factory reserves. Rename the state.');
});

test("a state named for is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the belongs-to method answers to
    f.define("user", { definition: userDefinition, states: { for: { name: "Grace" } } }),
  ).toThrow('The state "for" takes a name a factory reserves. Rename the state.');
});

test("a state named has is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the has-many method answers to
    f.define("user", { definition: userDefinition, states: { has: { name: "Grace" } } }),
  ).toThrow('The state "has" takes a name a factory reserves. Rename the state.');
});

test("a state named recycle is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the recycle method answers to
    f.define("user", { definition: userDefinition, states: { recycle: { name: "Grace" } } }),
  ).toThrow('The state "recycle" takes a name a factory reserves. Rename the state.');
});

test("a state named afterCreating is rejected where the factory is defined", async () => {
  const { f } = await factorioHarness();

  expect(() =>
    // @ts-expect-error a state may not take the name the callback method answers to
    f.define("user", { definition: userDefinition, states: { afterCreating: { name: "Grace" } } }),
  ).toThrow('The state "afterCreating" takes a name a factory reserves. Rename the state.');
});

test("a state named __proto__ becomes a method rather than a write to the prototype", async () => {
  const { f } = await factorioHarness();
  const users = f.define("user", { definition: userDefinition, states: { ["__proto__"]: { name: "Grace" } } });

  const user = await users.__proto__().create();

  expect(user.name).toBe("Grace");
});

test("creating never opens a transaction of its own", async () => {
  const { prisma, users } = await factorioHarness();
  const transaction = vi.spyOn(prisma, "$transaction");

  await users.count(2).create();

  expect(transaction).not.toHaveBeenCalled();
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function statesCheckedByTheCompiler(f: Factorio<TestClient>, client: TestClient): void {
  // Held rather than written inline: excess property checking reaches a fresh object literal only,
  // so a variable is what tells `Exact` apart from the compiler's own freshness rule.
  const held = { name: "Ada", nmae: "x" };
  const users = statefulUsers(f);

  void users.suspended().vip().create();
  void users.count(3).suspended().create();
  void users.using(client).vip().create();
  f.define("user", { definition: userDefinition, states: { withPost: { posts: { create: { title: "t" } } } } });

  // @ts-expect-error a state the config does not declare
  void users.suspndd;
  // @ts-expect-error a state naming a field the model does not have
  f.define("user", { definition: userDefinition, states: { bad: { nmae: "Ada" } } });
  // @ts-expect-error a state giving a field the wrong value type
  f.define("user", { definition: userDefinition, states: { bad: { name: 42 } } });
  // @ts-expect-error a state held in a variable, which excess property checking does not reach
  f.define("user", { definition: userDefinition, states: { bad: held } });
  // @ts-expect-error a state closure returning a field the model does not have
  f.define("user", { definition: userDefinition, states: { bad: () => ({ nmae: "Ada" }) } });
  // @ts-expect-error a state closure returning an object excess property checking does not reach
  f.define("user", { definition: userDefinition, states: { bad: () => held } });
  // @ts-expect-error a state naming a field the nested relation input does not have
  f.define("user", { definition: userDefinition, states: { bad: { posts: { create: { titel: "t" } } } } });

  void users.state({ name: "Grace" }).suspended().count(2).create();
  void users.state(({ attrs }) => ({ name: attrs.name ?? "Ada" })).create();
  // A closure returning a different shape per branch: both application sites must take it.
  void users.state(({ index }) => (index === 0 ? { name: "Ada" } : { email: "grace@example.com" })).create();
  f.define("user", {
    definition: userDefinition,
    states: { alternating: ({ index }) => (index === 0 ? { name: "Ada" } : { email: "grace@example.com" }) },
  });

  // @ts-expect-error one branch of a state closure naming a field the model does not have
  void users.state(({ index }) => (index === 0 ? { name: "Ada" } : { nmae: "Grace" }));
  // @ts-expect-error a config annotated without its state names carries no states
  const annotated: FactoryConfig<TestClient, "user"> = { definition: userDefinition, states: { bad: held } };
  void annotated;

  // @ts-expect-error an inline state naming a field the model does not have
  void users.state({ nmae: "Ada" });
  // @ts-expect-error an inline state held in a variable, which excess property checking does not reach
  void users.state(held);
  // @ts-expect-error an inline state closure returning a field the model does not have
  void users.state(() => ({ nmae: "Ada" }));
  // @ts-expect-error an inline state closure returning an object excess property checking does not reach
  void users.state(() => held);
}

test("state(partial) applies attributes the config never declared", async () => {
  const { users } = await factorioHarness();

  const user = await users.state({ name: "Grace" }).create();

  expect(user.name).toBe("Grace");
});

test("state(closure) is handed the context a declared state closure gets", async () => {
  const { users } = await factorioHarness();

  const user = await users.state(({ attrs, index }) => ({ name: `${String(attrs.name)} ${String(index)}` })).create();

  expect(user.name).toBe("Ada 0");
});

test("an inline state and a declared state apply in the order they were called", async () => {
  const { f } = await factorioHarness();

  const declaredLast = await statefulUsers(f).state({ name: "Grace" }).suspended().create();
  const inlineLast = await statefulUsers(f).suspended().state({ name: "Grace" }).create();

  expect(declaredLast.name).toBeNull();
  expect(inlineLast.name).toBe("Grace");
});

test("state returns a new factory rather than changing the one it was called on", async () => {
  const { users } = await factorioHarness();

  const renamed = users.state({ name: "Grace" });
  const user = await users.create();

  expect(renamed).not.toBe(users);
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
  const { users } = await factorioHarness();
  const spread = { ...users };

  for (const name of [
    "prisma-factorio.factory",
    "prisma-factorio.rebind",
    "prisma-factorio.parent",
    "prisma-factorio.recycle",
  ]) {
    expect(Symbol.for(name) in users).toBe(true);
    expect(Symbol.for(name) in spread).toBe(false);
  }
});

test("a factory embedded in a definition creates the parent and connects the record to it", async () => {
  const { prisma, posts } = await factorioHarness();

  const post = await posts.create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: post.authorId } })).resolves.toMatchObject({ name: "Ada" });
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a relation default reaching through several models creates one record of each", async () => {
  const { prisma, comments } = await factorioHarness();

  const comment = await comments.create();

  await expect(prisma.post.findUniqueOrThrow({ where: { id: comment.postId } })).resolves.toBeTruthy();
  await expect(prisma.post.count()).resolves.toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a factory embedded in a state creates the parent, and the layer it replaced is never evaluated", async () => {
  const { prisma, f, users } = await factorioHarness();
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { create: { email: `${uid}@example.com`, name: "Grace" } } }),
    states: { byAda: { author: users } },
  });

  await posts.byAda().create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ name: "Ada" }]);
});

test("a factory embedded in create() overrides creates the parent and connects the record to it", async () => {
  const { prisma, f } = await factorioHarness();
  const authors = f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, name: "Hedy" }) });
  const posts = f.define("post", { definition: ({ uid }) => ({ title: uid, author: { connect: { id: 404 } } }) });

  const post = await posts.create({ author: authors });

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ id: post.authorId, name: "Hedy" }]);
});

test("a row embedded in a relation field connects to it without creating a record", async () => {
  const { prisma, f, users } = await factorioHarness();
  const ada = await users.create();
  const posts = f.define("post", { definition: ({ uid }) => ({ title: uid, author: ada }) });

  const written = await posts.count(2).create();

  expect(written.map((post) => post.authorId)).toStrictEqual([ada.id, ada.id]);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("an override on a relation key replaces the definition's factory, which is never evaluated", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const grace = await users.create({ name: "Grace" });

  const post = await posts.create({ author: grace });

  expect(post.authorId).toBe(grace.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("native relation input naming connect reaches Prisma untouched", async () => {
  const { f, users } = await factorioHarness();
  const ada = await users.create();
  const posts = f.define("post", { definition: ({ uid }) => ({ title: uid, author: { connect: { id: ada.id } } }) });

  await expect(posts.create()).resolves.toMatchObject({ authorId: ada.id });
});

test("native relation input naming create reaches Prisma untouched", async () => {
  const { prisma, posts } = await factorioHarness();

  const post = await posts.create({ author: { create: { email: "grace@example.com", name: "Grace" } } });

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
    first: await harness.comments.create(),
    second: await harness.comments.create(),
    tag: await harness.tags.create(),
    other: await harness.tags.create(),
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

  const post = await harness.posts.create({ comments: [first, second] });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual(ids([first, second]));
});

test("an array of rows in create() overrides attaches every one across a many-to-many", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.posts.create({ tags: [tag, other] });

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual(ids([tag, other]));
});

test("an array of rows in a definition attaches every one of them", async () => {
  const { harness, first, second } = await spare();
  const drafts = harness.f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: harness.users, comments: [first, second] }),
  });

  const post = await drafts.create();

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual(ids([first, second]));
});

test("an array of rows in a state attaches every one of them", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.posts.state({ tags: [tag, other] }).create();

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual(ids([tag, other]));
});

// A relation field holding many records takes a single connect as readily as a list of them, so one
// row stands in it exactly as it stands in a field holding a single record.
test("a single row in a relation field holding many records attaches it", async () => {
  const { harness, first } = await spare();

  const post = await harness.posts.create({ comments: first });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toStrictEqual([first.id]);
});

test("a single row in a many-to-many relation field attaches it", async () => {
  const { harness, tag } = await spare();

  const post = await harness.posts.state({ tags: tag }).create();

  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
});

// The rows reach the parent's own create and the children are created after it, so which of them the
// relation ends up holding first is not the order the calls were made in.
test("an array of rows under a has() layer on the same field attaches alongside the children", async () => {
  const { harness, first, second } = await spare();

  const post = await harness.posts
    .state({ comments: [first, second] })
    .has(harness.comments, "comments")
    .create();
  const held = await attachedTo(harness.prisma, post.id, "comments");

  expect(held).toHaveLength(3);
  expect(held).toEqual(expect.arrayContaining(ids([first, second])));
});

test("an array of rows under a has() layer attaches alongside the children across a many-to-many", async () => {
  const { harness, tag, other } = await spare();

  const post = await harness.posts
    .state({ tags: [tag, other] })
    .has(harness.tags, "tags")
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

  await harness.posts
    .using(client)
    .state({ comments: [first] })
    .has([second], "comments")
    .create();

  expect(written[0]?.comments).toStrictEqual({ connect: [first, second] });
});

// Naming the field and leaving it empty would hand Prisma a nested write with nothing to do, which is
// the reading a `has` layer holding no children already takes.
test("an array holding no row leaves the relation field unwritten", async () => {
  const { prisma, posts } = await factorioHarness();
  const { client, written } = recording(prisma, "post");

  await posts.using(client).create({ comments: [], tags: [] });

  expect(Object.keys(written[0] ?? {})).toStrictEqual(["title", "author"]);
});

// A list stands for rows to connect on a relation field holding many records alone. One holding a
// single record has no reading for a list, empty or not, so the value reaches the delegate as it stands
// and Prisma refuses it rather than the field going silently unwritten.
test("an array in a relation field holding a single record reaches Prisma, which refuses it", async () => {
  const { posts, users } = await factorioHarness();
  const ada = await users.create();

  for (const editor of [[], [ada]]) {
    await expect(posts.create({ editor })).rejects.toThrow(
      "Argument `editor`: Invalid value provided. Expected UserCreateNestedOneWithoutEditedInput",
    );
  }
});

// The whole of Prisma's own nested input at this arity, none of it read as rows to connect. The
// many-to-many takes no `createMany`, the join table Prisma hides carrying no envelope of its own.
test("native relation input in a field holding many records reaches Prisma untouched", async () => {
  const { harness, first, tag } = await spare();

  const post = await harness.posts.create({
    comments: { connect: [{ id: first.id }], create: [{ body: "written" }], createMany: { data: [{ body: "made" }] } },
    tags: { connectOrCreate: [{ where: { id: tag.id }, create: { label: "reused" } }] },
  });

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(3);
  await expect(attachedTo(harness.prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
});

test("a relation default in a definition evaluates once per record, so a batch draws a parent each", async () => {
  const { prisma, posts } = await factorioHarness();

  const rows = await posts.count(3).create();

  expect(new Set(rows.map((post) => post.authorId)).size).toBe(3);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("the data handed to create carries the relation field as connect and never a foreign key column", async () => {
  const { prisma, posts } = await factorioHarness();
  const { client, written } = recording(prisma, "post");

  const post = await posts.using(client).create();
  const author = await prisma.user.findUniqueOrThrow({ where: { id: post.authorId } });

  expect(Object.keys(written[0] ?? {})).toStrictEqual(["title", "author"]);
  expect(written[0]?.author).toStrictEqual({ connect: author });
});

// The row's scalars go into the `where`, so every field beyond the unique one narrows it: a row read
// before the record changed no longer matches anything.
test("connecting a row that has since changed fails rather than reaching the record it became", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const ada = await users.create();
  await prisma.user.update({ where: { id: ada.id }, data: { name: "Grace" } });

  await expect(posts.create({ author: ada })).rejects.toMatchObject({ code: "P2025" });
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
  await harness.posts.create({ comments: first });

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

  const post = await attach(harness, harness.comments);

  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(1);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
}

test("a factory in a to-many definition slot creates its children once the parent row exists", async () => {
  await commented(({ f, users }, comments) =>
    f.define("post", { definition: ({ uid }) => ({ title: uid, author: users, comments }) }).create(),
  );
});

test("a factory in a to-many state slot creates its children once the parent row exists", async () => {
  await commented(({ posts }, comments) => posts.state({ comments }).create());
});

test("a factory in a to-many slot in create() overrides creates its children once the parent row exists", async () => {
  await commented(({ posts }, comments) => posts.create({ comments }));
});

type ChildComments = Factory<TestClient, "comment", Row<TestClient, "comment"> | Row<TestClient, "comment">[]>;

// The children wait outside the parent's own create, which then has nothing to say about the field they
// hang off: naming it there would hand Prisma either a connect for a record that does not exist yet or a
// nested write with nothing to do, the second being the reading `has([])` already takes. One post is
// written and no other, which is what the whole list of recorded creates pins.
async function unwritten(children: (harness: Harness) => ChildComments): Promise<Harness> {
  const harness = await factorioHarness();
  const { client, written } = recording(harness.prisma, "post");

  await harness.posts.using(client).create({ comments: children(harness) });

  expect(written.map((data) => Object.keys(data))).toStrictEqual([["title", "author"]]);

  return harness;
}

test("a factory in a to-many slot leaves the relation field unwritten in the parent's own create", async () => {
  await unwritten(({ comments }) => comments);
});

test("a to-many default batched to no records at all leaves the relation field unwritten", async () => {
  const { prisma } = await unwritten(({ comments }) => comments.count(0));

  await expect(prisma.comment.count()).resolves.toBe(0);
});

// The far side a child reaches back through is read off the pairing metadata, the value naming none, so
// a relation whose two sides both hold many records answers here as readily as a belongs-to one. The
// label is written from the row the tag was created for, which stands only once that row exists.
test("a factory in a many-to-many slot creates its record for the parent row and joins it", async () => {
  const { prisma, f, posts } = await factorioHarness();
  const credited = f.define("tag", {
    definition: ({ uid }) => ({ label: uid }),
    states: { credited: ({ parent }) => ({ label: `for ${String(parentId(parent))}` }) },
  });

  const post = await posts.create({ tags: credited.credited() });

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

  const written = await attach(harness, harness.comments.count(2));
  const counted = await Promise.all(
    written.map((post) => harness.prisma.comment.count({ where: { postId: post.id } })),
  );

  expect(counted).toStrictEqual([2, 2, 2]);
  await expect(harness.prisma.post.count()).resolves.toBe(3);
}

test("a to-many default in a definition draws children per parent record", async () => {
  await eachDrawingTwo(({ f, users }, comments) =>
    f
      .define("post", { definition: ({ uid }) => ({ title: uid, author: users, comments }) })
      .count(3)
      .create(),
  );
});

test("a to-many default in create() overrides draws children per parent record too", async () => {
  await eachDrawingTwo(({ posts }, comments) => posts.count(3).create({ comments }));
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
    harness.f.define("comment", {
      definition: ({ uid }) => {
        order.push(tag);
        return { body: uid, post: harness.posts };
      },
    });

  return { harness, order, tagged };
}

// A relation default is sugar for a `has` layer in what it does and a plain layer of the merge in how it
// folds: `has` adds to what the layers before it left standing, so a field a default already filled ends
// up holding both, the default's children created first.
test("a has() layer adds to the children a to-many default left standing, the default's created first", async () => {
  const { harness, order, tagged } = await folded();
  const drafts = harness.f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: harness.users, comments: tagged("default") }),
  });

  const post = await drafts.has(tagged("added"), "comments").create();

  expect(order).toStrictEqual(["default", "added"]);
  await expect(attachedTo(harness.prisma, post.id, "comments")).resolves.toHaveLength(2);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// The other order of the same pair: every layer that is not a `has` call replaces the relation field
// whole, the children gathered on it dropped along with it and never evaluated.
test("a to-many default after has() replaces the field, the children it had gathered never evaluated", async () => {
  const { harness, order, tagged } = await folded();

  const gathered = harness.posts.has(tagged("dropped"), "comments");
  const post = await gathered.state({ comments: tagged("kept") }).create();

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
  const labelled = harness.f.define("tag", {
    definition: ({ uid }) => {
      order.push("tag");
      return { label: uid };
    },
  });
  const drafts = harness.f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: harness.users, tags: labelled, comments: tagged("comment") }),
  });

  await drafts.has(tagged("added"), "comments").create();

  expect(order).toStrictEqual(["tag", "comment", "added"]);
});

// Distinct from the harness's own user factory, which names every record "Ada": whichever name the
// created parent carries says which layer of the merge was the one evaluated.
function otherUsers(f: Factorio<TestClient>): Factory<TestClient, "user"> {
  return f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, name: "Hedy" }) });
}

test("for(factory) creates the parent and connects the record to it", async () => {
  const { prisma, posts, users } = await factorioHarness();

  const post = await posts.for(users, "author").create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: post.authorId } })).resolves.toMatchObject({ name: "Ada" });
});

test("for(row) connects to a record that already exists rather than creating one", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const ada = await users.create();

  const post = await posts.for(ada, "author").create();

  expect(post.authorId).toBe(ada.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("for(factory) resolves the one relation the model pair shares when the name is left out", async () => {
  const { prisma, comments, posts } = await factorioHarness();

  const comment = await comments.for(posts).create();

  expect(comment.postId).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(1);
});

test("for(row) reads the model a row belongs to off the fields it carries when the name is left out", async () => {
  const { comments, posts } = await factorioHarness();
  const post = await posts.create();

  const comment = await comments.for(post).create();

  expect(comment.postId).toBe(post.id);
});

// The return annotations are checked against the client's own inference, which is what keeps these
// honest stand-ins for what `include` hands back: the model's scalars, loaded relation alongside.
async function userWithPosts({ prisma, users }: Harness): Promise<Row<TestClient, "user"> & { posts: unknown[] }> {
  const ada = await users.create();

  return prisma.user.findUniqueOrThrow({ where: { id: ada.id }, include: { posts: true } });
}

async function postWithComments({
  prisma,
  posts,
}: Harness): Promise<Row<TestClient, "post"> & { comments: unknown[] }> {
  const post = await posts.create();

  return prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { comments: true } });
}

test("for(row) loaded with include connects on the row's scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness();
  const loaded = await userWithPosts(harness);
  const { client, written } = recording(harness.prisma, "post");

  const post = await harness.posts.using(client).for(loaded, "author").create();

  expect(post.authorId).toBe(loaded.id);
  expect(written[0]?.author).toStrictEqual({ connect: { id: loaded.id, email: loaded.email, name: loaded.name } });
});

test("for(row) loaded with include resolves the relation field when the name is left out", async () => {
  const harness = await factorioHarness();
  const loaded = await postWithComments(harness);

  const comment = await harness.comments.for(loaded).create();

  expect(comment.postId).toBe(loaded.id);
});

test("a row loaded with include stands in a relation default, in a definition and in overrides", async () => {
  const harness = await factorioHarness();
  const loaded = await userWithPosts(harness);
  const authored = harness.f.define("post", { definition: ({ uid }) => ({ title: uid, author: loaded }) });

  const fromDefinition = await authored.create();
  const fromOverrides = await harness.posts.create({ author: loaded });

  expect([fromDefinition.authorId, fromOverrides.authorId]).toStrictEqual([loaded.id, loaded.id]);
});

test("for() beats the relation default in the definition, which is never evaluated", async () => {
  const { prisma, f, posts } = await factorioHarness();

  await posts.for(otherUsers(f), "author").create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ name: "Hedy" }]);
});

test("for() and a state resolve the relation field they share by call order", async () => {
  const { prisma, f, users } = await factorioHarness();
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: { byHedy: { author: otherUsers(f) } },
  });

  const forLast = await posts.byHedy().for(users, "author").create();
  const stateLast = await posts.for(users, "author").byHedy().create();

  await expect(prisma.user.findUniqueOrThrow({ where: { id: forLast.authorId } })).resolves.toMatchObject({
    name: "Ada",
  });
  await expect(prisma.user.findUniqueOrThrow({ where: { id: stateLast.authorId } })).resolves.toMatchObject({
    name: "Hedy",
  });
});

test("create(overrides) beats for() on the relation field they share, whose parent is never evaluated", async () => {
  const { prisma, f, posts, users } = await factorioHarness();
  const grace = await users.create({ name: "Grace" });

  const post = await posts.for(otherUsers(f), "author").create({ author: grace });

  expect(post.authorId).toBe(grace.id);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("two for() calls naming different relation fields both apply", async () => {
  const { posts, users } = await factorioHarness();
  const ada = await users.create();
  const grace = await users.create({ name: "Grace" });

  const post = await posts.for(ada, "author").for(grace, "editor").create();

  expect([post.authorId, post.editorId]).toStrictEqual([ada.id, grace.id]);
});

test("two for() calls naming one relation field resolve last-write-wins, the loser never evaluated", async () => {
  const { prisma, f, posts, users } = await factorioHarness();

  const post = await posts.for(otherUsers(f), "author").for(users, "author").create();

  await expect(prisma.user.findMany()).resolves.toMatchObject([{ id: post.authorId, name: "Ada" }]);
});

test("count(3).for(factory) creates one parent the whole batch connects to", async () => {
  const { prisma, posts, users } = await factorioHarness();

  const rows = await posts.count(3).for(users, "author").create();

  expect(new Set(rows.map((post) => post.authorId)).size).toBe(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("each create() call draws a parent of its own, so two calls connect to two records", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const authored = posts.for(users, "author");

  await authored.create();
  await authored.create();

  await expect(prisma.user.count()).resolves.toBe(2);
});

test("a state survives for() in either chaining order and applies", async () => {
  const { f, users } = await factorioHarness();
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: { drafted: { title: "draft" } },
  });

  const stateLast = await posts.for(users, "author").drafted().create();
  const forLast = await posts.drafted().for(users, "author").create();

  expect([stateLast.title, forLast.title]).toStrictEqual(["draft", "draft"]);
});

test("for returns a new factory rather than changing the one it was called on", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const ada = await users.create();

  const authored = posts.for(ada, "author");
  await posts.create();

  expect(authored).not.toBe(posts);
  await expect(prisma.user.count()).resolves.toBe(2);
});

// Prisma reports a typo'd relation key on a required relation as the untyped key being missing, so
// the library names the key it was given itself.
test("for() rejects a relation field the model pair does not share, naming it and the candidates", async () => {
  const { posts, users } = await factorioHarness();

  await expect(posts.for(users, "illustrator" as unknown as "author").create()).rejects.toThrow(
    'The model "post" has no relation field "illustrator" pointing at "user". ' +
      'Relation fields on "post" pointing at "user": "author", "editor".',
  );
});

// The type layer rejects the omitted name here; the runtime says the same thing to a caller who
// compiles nothing, and names the escape hatch, which the runtime alone cannot narrow down to one.
test("for() rejects an omitted relation field where the model pair shares several, naming them", async () => {
  const { posts, users } = await factorioHarness();
  const bypassed = posts as unknown as { for: (parent: unknown) => Factory<TestClient, "post"> };

  await expect(bypassed.for(users).create()).rejects.toThrow(
    'The model "post" has more than one relation field pointing at "user". Pass the relation field explicitly. ' +
      'Relation fields on "post" pointing at "user": "author", "editor".',
  );
});

// A `for` call names one parent record, which a relation field holding many records has no reading
// for. The type layer rejects it; the runtime says the same thing to a caller who compiles nothing,
// rather than writing a record that hangs off no parent at all.
test("for() rejects a relation field holding many records, naming it and the arity", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const bypassing = users as unknown as { for: (parent: unknown, field: string) => Factory<TestClient, "user"> };

  await expect(bypassing.for(posts, "posts").create()).rejects.toThrow(
    'The relation field "posts" on the model "user" holds many records, which for() has no reading for. ' +
      "Attach the records with has() instead.",
  );
  await expect(prisma.post.count()).resolves.toBe(0);
});

test("for() hands create the relation field as connect and never a foreign key column", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const { client, written } = recording(prisma, "post");
  const ada = await users.create();

  await posts.using(client).for(ada, "editor").create();

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

// The harness bootstraps on a database of its own, so a parent created through the bootstrap client
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
  await withoutOrphans(({ posts, users }, tx) => posts.for(users, "author").using(tx).create());
});

test("a relation default in a definition is created through the client using() named", async () => {
  await withoutOrphans(({ posts }, tx) => posts.using(tx).create());
});

test("a relation default reaching through several models runs every level on that client", async () => {
  await withoutOrphans(({ comments }, tx) => comments.using(tx).create(), [1, 1, 1]);
});

test("a to-many default creates its children on that client too, a rollback leaving neither behind", async () => {
  await withoutOrphans(({ comments, posts }, tx) => posts.using(tx).create({ comments }), [1, 1, 1]);
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
  await throughItsOwnClient("user", ({ posts, users }, own, tx) =>
    posts.for(users.using(own), "author").using(tx).create(),
  );
});

// Two bootstraps over one client: an in-memory SQLite database belongs to one connection, so a second
// client would be a second, empty database and the post could connect no user across it. What tells
// the two apart is the client each record is written through, which the recorded delegate reports —
// the recorded one for a factory the resolving chain rebound, the bare one for a factory that kept its
// own. The user is counted either way, so a run writing nothing at all fails both directions.
async function acrossBootstraps(
  bind: (users: Factory<TestClient, "user">, client: TestClient) => Factory<TestClient, "user">,
): Promise<[recorded: number, created: number]> {
  const { prisma, posts } = await factorioHarness();
  const elsewhere = initPrismaFactorio(prisma).define("user", { definition: userDefinition });
  const { client, written } = recording(prisma, "user");

  await posts.for(bind(elsewhere, prisma), "author").using(client).create();

  return [written.length, await prisma.user.count()];
}

test("a parent factory of another bootstrap that named no client is rebound to the resolving one", async () => {
  await expect(acrossBootstraps((users) => users)).resolves.toStrictEqual([1, 1]);
});

test("a parent factory of another bootstrap keeps the client its own using() named", async () => {
  await expect(acrossBootstraps((users, client) => users.using(client))).resolves.toStrictEqual([0, 1]);
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

  return { harness, first: await harness.posts.create(), second: await harness.posts.create() };
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
  attach: (users: Factory<TestClient, "user">) => { create: () => Promise<unknown> },
): Promise<Record<string, unknown>[]> {
  const { client, written } = recording(harness.prisma, "user");

  await attach(harness.users.using(client)).create();

  return written;
}

async function userCreateData(
  harness: Harness,
  attach: (users: Factory<TestClient, "user">) => Factory<TestClient, "user">,
): Promise<Record<string, unknown>> {
  return (await userWrites(harness, attach))[0] ?? {};
}

test("has(rows) connects records that already exist rather than creating any", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.users.has([first, second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
  await expect(harness.prisma.post.count()).resolves.toBe(2);
});

test("has(row) takes one row where the relation holds many", async () => {
  const { harness, first } = await attachable();

  const user = await harness.users.has(first, "edited").create();

  await expect(harness.prisma.post.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({
    editorId: user.id,
  });
});

test("has(rows) resolves the one has-many relation the model pair shares when the name is left out", async () => {
  const { prisma, comments, posts } = await factorioHarness();
  const comment = await comments.create();

  const post = await posts.has([comment]).create();

  await expect(prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).resolves.toMatchObject({
    postId: post.id,
  });
});

test("has() rejects a relation field the model pair does not share, naming it and the candidates", async () => {
  const { harness, first } = await attachable();

  await expect(harness.users.has([first], "illustrated" as unknown as "posts").create()).rejects.toThrow(
    'The model "user" has no relation field "illustrated" pointing at "post". ' +
      'Relation fields on "user" pointing at "post": "posts", "edited".',
  );
});

// An empty list stands for no model, so the pair the non-empty forms name is out of reach and the
// field is checked against the ones the model declares alone.
test("has([]) rejects a relation field the model does not declare, naming it and the candidates", async () => {
  const { users } = await factorioHarness();

  await expect(users.has([], "illustrated" as unknown as "posts").create()).rejects.toThrow(
    'The model "user" has no relation field "illustrated". Relation fields on "user": "posts", "edited", "memberships".',
  );
});

test("has([]) creates the parent and no record beyond it", async () => {
  const { prisma, users } = await factorioHarness();

  const user = await users.has([], "posts").create();

  expect(user.id).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(0);
});

// Naming the field and leaving it empty would hand Prisma a nested write with nothing to do.
test("a has layer the parent's own create has nothing to connect leaves the relation field unwritten", async () => {
  const harness = await factorioHarness();

  const none = await userCreateData(harness, (users) => users.has([], "posts"));
  const children = await userCreateData(harness, (users) => users.has(harness.posts, "posts"));

  expect(Object.keys(none)).toStrictEqual(["email", "name"]);
  expect(Object.keys(children)).toStrictEqual(["email", "name"]);
});

test("has(rows) hands create the relation field as a connect list of the rows' scalars", async () => {
  const { harness, first, second } = await attachable();

  const data = await userCreateData(harness, (users) => users.has([first, second], "posts"));

  expect(data.posts).toStrictEqual({ connect: [first, second] });
});

test("has(rows) loaded with include connects on the rows' scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness();
  const loaded = await postWithComments(harness);
  const { comments, ...scalars } = loaded;

  const data = await userCreateData(harness, (users) => users.has([loaded], "posts"));

  expect(comments).toStrictEqual([]);
  expect(data.posts).toStrictEqual({ connect: [scalars] });
});

test("two has() calls on one relation field both apply", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.users.has([first], "posts").has([second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
});

test("two has() calls naming different relation fields both apply", async () => {
  const { harness, first, second } = await attachable();

  const user = await harness.users.has([first], "posts").has([second], "edited").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id]);
  await expect(harness.prisma.post.findMany({ where: { editorId: user.id } })).resolves.toMatchObject([
    { id: second.id },
  ]);
});

test("has() adds to the relation field a state before it left standing", async () => {
  const { harness, first, second } = await attachable();

  const held = harness.users.state({ posts: { connect: [{ id: first.id }] } });
  const user = await held.has([second], "posts").create();

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([first.id, second.id]);
});

// The state names the relation field the `has` layer before it gathered children on, so what the
// parent ends up connected to is what the merge left of that field.
async function replacedByAState(
  { harness, second }: Attachable,
  children: readonly Row<TestClient, "post">[] | Factory<TestClient, "post">,
): Promise<number[]> {
  const gathered = harness.users.has(children, "posts");
  const user = await gathered.state({ posts: { connect: [{ id: second.id }] } }).create();

  return authoredBy(harness.prisma, user.id);
}

test("a state after has() replaces the relation field, the children it had gathered dropped", async () => {
  const target = await attachable();

  await expect(replacedByAState(target, [target.first])).resolves.toStrictEqual([target.second.id]);
});

test("create(overrides) replaces the relation field has() filled, the children it had gathered dropped", async () => {
  const { harness, first, second } = await attachable();

  const gathered = harness.users.has([first], "posts");
  const user = await gathered.create({ posts: { connect: [{ id: second.id }] } });

  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([second.id]);
});

test("has returns a new factory rather than changing the one it was called on", async () => {
  const { harness, first } = await attachable();

  const authored = harness.users.has([first], "posts");
  const user = await harness.users.create();

  expect(authored).not.toBe(harness.users);
  await expect(authoredBy(harness.prisma, user.id)).resolves.toStrictEqual([]);
});

test("has(factory) creates the children through their own factory and connects them to the parent", async () => {
  const { prisma, posts, users } = await factorioHarness();

  const user = await users.has(posts, "posts").create();

  await expect(authoredBy(prisma, user.id)).resolves.toHaveLength(1);
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The deliberate opposite of `for`, where one parent is shared by the whole batch.
test("has(factory) creates the children per parent record, so every record of a batch draws its own", async () => {
  const { prisma, posts, users } = await factorioHarness();

  const rows = await users.count(3).has(posts.count(2), "posts").create();
  const counted = await Promise.all(rows.map((user) => prisma.post.count({ where: { authorId: user.id } })));

  expect(counted).toStrictEqual([2, 2, 2]);
  await expect(prisma.post.count()).resolves.toBe(6);
});

// A record is evaluated in the same stretch of the loop that creates it, so the order the layers
// report themselves in is the order the records reach the database in.
test("the children of one record are created before the next record, layers in the order called", async () => {
  const { f, posts } = await factorioHarness();
  const order: string[] = [];
  const tagged = (tag: string): Factory<TestClient, "comment"> =>
    f.define("comment", {
      definition: ({ uid }) => {
        order.push(tag);
        return { body: uid, post: posts };
      },
    });

  const parents = posts.state(() => {
    order.push("post");
    return {};
  });
  await parents.count(2).has(tagged("a"), "comments").has(tagged("b"), "comments").create();

  expect(order).toStrictEqual(["post", "a", "b", "post", "a", "b"]);
});

// The state names one of the two relation fields, so the key the layer after it adds is the second
// one the parent's own attributes carry: what the children are created in is call order, not the
// order the keys of that merge happen to fall in.
test("two has() layers on different relation fields create their children in the order called", async () => {
  const { f, users } = await factorioHarness();
  const order: string[] = [];
  const tagged = (tag: string): Factory<TestClient, "post"> =>
    f.define("post", {
      definition: ({ uid }) => {
        order.push(tag);
        return { title: uid, author: users };
      },
    });

  const held = users.state({ posts: { connect: [] } });
  await held.has(tagged("edited"), "edited").has(tagged("posts"), "posts").create();

  expect(order).toStrictEqual(["edited", "posts"]);
});

test("has(factory) batched to no records at all creates the parent and no child", async () => {
  const { prisma, posts, users } = await factorioHarness();

  const user = await users.has(posts.count(0), "posts").create();

  expect(user.id).toBeGreaterThan(0);
  await expect(prisma.post.count()).resolves.toBe(0);
});

test("a child factory brings its own states and its own relation defaults", async () => {
  const { prisma, f, users } = await factorioHarness();
  const drafts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: otherUsers(f) }),
    states: { drafted: { title: "draft" } },
  });

  const user = await users.has(drafts.drafted(), "edited").create();

  await expect(prisma.post.findMany({ where: { editorId: user.id } })).resolves.toMatchObject([{ title: "draft" }]);
  await expect(prisma.user.findMany({ orderBy: { id: "asc" } })).resolves.toMatchObject([
    { name: "Ada" },
    { name: "Hedy" },
  ]);
});

test("a child factory's own has() reaches the level below it", async () => {
  const { prisma, comments, posts, users } = await factorioHarness();

  const user = await users.has(posts.has(comments, "comments"), "posts").create();
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
  const { prisma, f, users } = await factorioHarness();
  const credited = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: { credited: ({ parent }) => ({ title: `by ${String(parentId(parent))}` }) },
  });

  const user = await users.has(credited.credited(), "posts").create();

  await expect(prisma.post.findMany()).resolves.toMatchObject([{ title: `by ${String(user.id)}` }]);
});

// The row is handed over by deriving a chain of its own, so the factory the caller holds is the one
// they declared: a record it goes on to create for no one reads the record of a run already over.
test("a child factory reused after a has() chain reads no parent of its own", async () => {
  const { prisma, f, users } = await factorioHarness();
  const seen: (number | undefined)[] = [];
  const credited = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: {
      recorded: ({ parent }) => {
        seen.push(parentId(parent));
        return {};
      },
    },
  });

  // One factory across both calls, naming the client it runs on: a fresh factory would carry a chain
  // of its own with nothing to go stale, and one the run rebinds would be shielded by that rebinding.
  const recorded = credited.recorded().using(prisma);
  await users.has(recorded, "posts").create();
  await recorded.create();

  expect(seen).toStrictEqual([expect.any(Number), undefined]);
});

// A user and a post are created first, so the two rows the graph then draws carry different ids and
// the one the grandchild names is the record above it rather than the record it shares an id with.
test("a grandchild reads the record just above it through parent, not the top of the chain", async () => {
  const { prisma, f, posts, users } = await factorioHarness();
  const credited = f.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: posts }),
    states: { credited: ({ parent }) => ({ body: `for ${String(parentId(parent))}` }) },
  });
  await users.create();

  const user = await users.has(posts.has(credited.credited(), "comments"), "posts").create();
  const [post] = await prisma.post.findMany({ where: { authorId: user.id } });

  expect(post?.id).not.toBe(user.id);
  await expect(prisma.comment.findMany()).resolves.toMatchObject([{ body: `for ${String(post?.id)}` }]);
});

test("two create() calls on one has() chain build the same graph each time", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const authored = users.has(posts.count(2), "posts");

  const first = await authored.create();
  const second = await authored.create();

  await expect(authoredBy(prisma, first.id)).resolves.toHaveLength(2);
  await expect(authoredBy(prisma, second.id)).resolves.toHaveLength(2);
  await expect(prisma.post.count()).resolves.toBe(4);
});

test("a layer replacing the relation field drops the child factory, which is never evaluated", async () => {
  const target = await attachable();

  await expect(replacedByAState(target, target.harness.posts)).resolves.toStrictEqual([target.second.id]);
  await expect(target.harness.prisma.post.count()).resolves.toBe(2);
});

// The rows reach the parent's own create and the factory's records are created after it, so a field
// carrying both forms is where the two halves of `has` have to agree.
test("a has() layer of rows and one of a factory on one relation field both apply", async () => {
  const { harness, first } = await attachable();

  const user = await harness.users.has([first], "posts").has(harness.posts, "posts").create();
  const authored = await authoredBy(harness.prisma, user.id);

  expect(authored).toHaveLength(2);
  expect(authored).toContain(first.id);
});

test("has(factory) creates the children through the client using() named, so a rollback drops them", async () => {
  await withoutOrphans(({ posts, users }, tx) => users.has(posts, "posts").using(tx).create());
});

test("a child factory naming a client of its own is created through it, not the resolving one", async () => {
  await throughItsOwnClient("post", ({ posts, users }, own, tx) =>
    users.has(posts.using(own), "posts").using(tx).create(),
  );
});

// A child factory is handed its parent row and its client both, and the two are read off the same
// chain: a level taking one of them from the wrong place still creates the record, on the client the
// factory was declared under, where nothing rolls it back.
test("a nested has() creates the level below the children on that client too", async () => {
  await withoutOrphans(
    ({ comments, posts, users }, tx) => users.has(posts.has(comments, "comments"), "posts").using(tx).create(),
    [1, 1, 1],
  );
});

test("a has() graph reached through a relation default creates its children on that client", async () => {
  await withoutOrphans(
    ({ f, posts, users }, tx) =>
      f
        .define("post", { definition: ({ uid }) => ({ title: uid, author: users.has(posts, "posts") }) })
        .using(tx)
        .create(),
    [1, 2, 0],
  );
});

test("a has() factory standing as a for() parent creates its children on that client", async () => {
  await withoutOrphans(
    ({ posts, users }, tx) => posts.for(users.has(posts, "posts"), "author").using(tx).create(),
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
  const { prisma, posts, users } = await factorioHarness();
  const lookup = lookupThatThrows();

  const user = await users.has(posts, "posts", { inverse: "author" }).create();

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
  await commentedWithoutTheLookup(({ comments, posts }) => posts.has(comments, { inverse: "post" }));
});

// The cast is what `exactOptionalPropertyTypes` costs: this package compiles under it, so the slot a
// skippable relation field leaves takes no explicit `undefined` here. A caller compiling without it —
// the default — or compiling nothing at all reaches this call as written.
test("a relation field passed as undefined leaves the options at the tail, the lookup never reached", async () => {
  await commentedWithoutTheLookup(({ comments, posts }) =>
    posts.has(comments, undefined as unknown as "comments", { inverse: "post" }),
  );
});

// The three messages the lookup itself throws all point at this option, so a name mistyped in it has
// to answer as a library error rather than as a Prisma invocation the caller cannot place.
test("the inverse option rejects a name that is no relation field of the child pointing at the parent", async () => {
  const { posts, users } = await factorioHarness();

  for (const inverse of ["writer", "title"]) {
    await expect(users.has(posts, "posts", { inverse }).create()).rejects.toThrow(
      `The model "post" has no relation field "${inverse}" pointing at "user". ` +
        'Relation fields on "post" pointing at "user": "author", "editor".',
    );
  }
});

test("the inverse option is checked before the parent record is written", async () => {
  const { prisma, posts, users } = await factorioHarness();

  await expect(users.has(posts, "posts", { inverse: "writer" }).create()).rejects.toThrow(TypeError);
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
  attach: (posts: Factory<TestClient, "post">, children: ChildComments) => Factory<TestClient, "post", unknown>,
): Promise<Factory<TestClient, "post", unknown>> {
  const harness = await factorioHarness();

  return attach(harness.posts, harness.comments).using(unpaired(harness.prisma, "Post", "comments"));
}

const unreadablePairing =
  'The relation field "comments" on the model "post" carries no metadata pairing it with a relation field on "comment". ';

const commentFields = 'Relation fields on "comment": "post".';

test("a has() layer whose inverse cannot be read steers to the option that names it", async () => {
  const posts = await withoutPairing((posts, comments) => posts.has(comments, "comments"));

  await expect(posts.create()).rejects.toThrow(
    unreadablePairing + 'Pass the inverse relation field as the "inverse" option of has(). ' + commentFields,
  );
});

// A relation default carries no options to name the inverse through, so the throw steers to the call
// that does rather than to an option this route never reaches.
test("a to-many default whose inverse cannot be read steers to has() instead", async () => {
  const posts = await withoutPairing((posts, comments) => posts.state({ comments }));

  await expect(posts.create()).rejects.toThrow(
    unreadablePairing +
      "A relation default takes no options: attach the children with has(children, field, { inverse }) instead. " +
      commentFields,
  );
});

// An implicit many-to-many holds many records at both ends, so `has` reaches it from either one and
// the relation field is skippable on both. The join table Prisma keeps hidden carries no model of its
// own, which is why none of this needs machinery beyond what a one-to-many already uses.
test("has(factory) joins the children to the parent across an implicit many-to-many", async () => {
  const { prisma, posts, tags } = await factorioHarness();

  const post = await posts.has(tags.count(3)).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(joined.tags).toHaveLength(3);
  await expect(prisma.tag.count()).resolves.toBe(3);
});

test("has(factory) reaches a many-to-many from the far end just as well", async () => {
  const { prisma, posts, tags } = await factorioHarness();

  const tag = await tags.has(posts.count(2)).create();
  const joined = await prisma.tag.findUniqueOrThrow({ where: { id: tag.id }, include: { posts: true } });

  expect(joined.posts).toHaveLength(2);
});

test("has(rows) attaches records that already exist across a many-to-many, creating none", async () => {
  const { prisma, posts, tags } = await factorioHarness();
  const existing = await tags.count(2).create();

  const post = await posts.has(existing).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(new Set(joined.tags.map((tag) => tag.id))).toStrictEqual(new Set(existing.map((tag) => tag.id)));
  await expect(prisma.tag.count()).resolves.toBe(2);
});

test("a many-to-many draws its children per parent record, the cadence every has() layer keeps", async () => {
  const { prisma, posts, tags } = await factorioHarness();

  await posts.count(3).has(tags.count(2)).create();
  const joined = await prisma.post.findMany({ include: { tags: true } });

  expect(joined.map((post) => post.tags.length)).toStrictEqual([2, 2, 2]);
  await expect(prisma.tag.count()).resolves.toBe(6);
});

// An explicit many-to-many is composition rather than a method of its own: the datamodel holds no
// relation between the two far models, so the join model's factory is what stands between them, and
// its pivot columns are ordinary typed attributes a state reaches like any other.
test("has(joinModel) composes an explicit many-to-many, the placeholder parent never evaluated", async () => {
  const { prisma, users, memberships } = await factorioHarness();

  const ada = await users.has(memberships.count(2).state({ role: "admin" }), "memberships").create();
  const joined = await prisma.membership.findMany({ where: { userId: ada.id } });

  expect(joined.map((membership) => membership.role)).toStrictEqual(["admin", "admin"]);
  expect(new Set(joined.map((membership) => membership.teamId)).size).toBe(2);
  await expect(prisma.team.count()).resolves.toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("the join model's relation field may be left out, the pair sharing exactly one", async () => {
  const { prisma, users, memberships } = await factorioHarness();

  const ada = await users.has(memberships.count(2)).create();

  await expect(prisma.membership.count({ where: { userId: ada.id } })).resolves.toBe(2);
});

// The join model reached as a relation default rather than as a `has` layer: its records are created
// once the parent row exists, so each carries the compound key whole and the leg the parent stands in
// replaces the factory the definition names there, leaving no user behind.
test("a batched factory in the join model's relation field creates its records for the parent", async () => {
  const { prisma, users, memberships } = await factorioHarness();

  const ada = await users.create({ memberships: memberships.count(2) });
  const held = await prisma.membership.findMany({ where: { userId: ada.id } });

  expect(held).toHaveLength(2);
  expect(new Set(held.map((row) => row.teamId)).size).toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("for() names a leg of the join model, each record bringing the far side of its own", async () => {
  const { prisma, users, memberships } = await factorioHarness();
  const ada = await users.create();

  await memberships.count(2).for(ada).create();

  await expect(prisma.membership.count({ where: { userId: ada.id } })).resolves.toBe(2);
  await expect(prisma.team.count()).resolves.toBe(2);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a state pins an existing row into a leg of the join model rather than drawing a new one", async () => {
  const { prisma, users, teams, memberships } = await factorioHarness();
  const ada = await users.create();
  const team = await teams.create();

  const membership = await memberships.for(ada).state({ team }).create();

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
  const ada = await harness.users.create();

  return { harness, membership: await harness.memberships.for(ada).create() };
}

// The join model's only unique constraint is its compound key, which Prisma exposes under the single
// generated name `userId_teamId` and demands under that name; the flat scalars a row carries satisfy
// no `WhereUniqueInput`. Tracked as issue #41, whose workaround is passing native relation input,
// `{ connect: { userId_teamId: … } }`. The README paragraph naming #41 stands or falls with this test.
test("connecting an existing join-model row fails on its compound key", async () => {
  const { harness, membership } = await joined();

  await expect(harness.users.has([membership], "memberships").create()).rejects.toThrow(
    "Expected MembershipWhereUniqueInput",
  );
});

// The same compound key reached through the relation field itself rather than through a `has` layer: a
// list of rows connects on the target model's scalars either way, and the flat scalars a join-model row
// carries satisfy no `WhereUniqueInput`. Tracked as issue #41, whose workaround is passing native
// relation input, `{ connect: { userId_teamId: … } }`. The README paragraph naming #41 stands or falls
// with this test.
test("a list of existing join-model rows in a relation field fails on the compound key", async () => {
  const { harness, membership } = await joined();

  await expect(harness.users.create({ memberships: [membership] })).rejects.toThrow(
    "Expected MembershipWhereUniqueInput",
  );
});

// The same compound key reached by a single row rather than a list of them: a row standing alone lands in
// `connect` as a bare object, so Prisma names the array type it expected where a list has it name the
// element type, and the flat scalars a join-model row carries satisfy neither. Tracked as issue #41, whose
// workaround is passing native relation input, `{ connect: { userId_teamId: … } }`. The README paragraph
// naming #41 stands or falls with this test.
test("an existing join-model row standing in a relation field fails on the compound key", async () => {
  const { harness, membership } = await joined();

  await expect(harness.users.create({ memberships: membership })).rejects.toThrow(
    "Expected MembershipWhereUniqueInput[], provided Object.",
  );
});

// The schema being enforced, not the library misbehaving: one user belongs to one team once.
test("two join-model records of the same pair collide on the compound key", async () => {
  const { users, teams, memberships } = await factorioHarness();
  const ada = await users.create();
  const team = await teams.create();

  await expect(memberships.count(2).for(ada).state({ team }).create()).rejects.toThrow(
    "Unique constraint failed on the fields: (`userId`, `teamId`)",
  );
});

test("recycle() hands back a factory of its own rather than the receiver", async () => {
  const { users } = await factorioHarness();
  const ada = await users.create();

  expect(users.recycle("user", ada)).not.toBe(users);
});

// An empty pool stands for a model that was never recycled, so the call is legal and changes nothing
// — the same reading `has` gives a list of no children.
test("recycle() pooling no rows leaves a factory that creates exactly as it did", async () => {
  const { prisma, users } = await factorioHarness();

  const user = await users.recycle("user", []).create();

  expect(user.name).toBe("Ada");
  await expect(prisma.user.count()).resolves.toBe(1);
});

// The harness's own post factory names an author alone, and one pooled row filling two slots of one
// model is what tells a pick from a record drawn fresh for each. Local to these tests: widening the
// harness would move the row counts every other suite in this file asserts.
async function editedPosts(options: FactorioOptions = {}): Promise<Harness> {
  const harness = await factorioHarness(options);
  const { f, users } = harness;
  const posts = f.define("post", { definition: ({ uid }) => ({ title: uid, author: users, editor: users }) });
  const comments = f.define("comment", { definition: ({ uid }) => ({ body: uid, post: posts }) });

  return { ...harness, posts, comments };
}

interface Pooling {
  harness: Harness;
  posts: Factory<TestClient, "post">;
  comments: Factory<TestClient, "comment">;
  ada: Row<TestClient, "user">;
}

// One user already written and a graph pooling it, which is where every precedence case starts.
async function pooling(options: FactorioOptions = {}): Promise<Pooling> {
  const harness = await editedPosts(options);
  const ada = await harness.users.create();

  return {
    harness,
    posts: harness.posts.recycle("user", ada),
    comments: harness.comments.recycle("user", ada),
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
  const { harness, comments, ada } = await pooling();

  const comment = await comments.create();

  await expect(slotsAndUsers(harness, await postBehind(harness, comment))).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("the same graph pooling nothing draws a record of its own per slot", async () => {
  const harness = await editedPosts();

  const comment = await harness.comments.create();
  const [author, editor, written] = await slotsAndUsers(harness, await postBehind(harness, comment));

  expect(author).not.toBe(editor);
  expect(written).toBe(2);
});

// A caller pools rows it loaded itself, and an `include`d relation is no field to match a record on.
test("a pooled row loaded with include connects on its scalars, the loaded relation left out", async () => {
  const harness = await editedPosts();
  const ada = await userWithPosts(harness);

  const post = await harness.posts.recycle("user", ada).create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("recycle(model, []) leaves the graph creating the related records it always did", async () => {
  const { prisma, posts } = await editedPosts();

  await posts.recycle("user", []).create();

  await expect(prisma.user.count()).resolves.toBe(2);
});

// The pool stands for the related records a graph reaches, which the record a create was called for
// is not: a factory pooling rows of its own model creates all the same.
test("the model a factory creates is never drawn from its own pool", async () => {
  const { prisma, comments } = await factorioHarness();
  const first = await comments.create();

  const second = await comments.recycle("comment", first).create();

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
  const { harness, posts, ada } = await pooling();

  const post = await posts.for(harness.users, "author").create();

  await createdThenDrawn(harness, post, ada);
});

test("an override holding a factory beats the pool, which still fills the slots it left alone", async () => {
  const { harness, posts, ada } = await pooling();

  const post = await posts.create({ author: harness.users });

  await createdThenDrawn(harness, post, ada);
});

interface NativeAuthored {
  harness: Harness;
  posts: Factory<TestClient, "post", Row<TestClient, "post">, { credited: unknown }>;
  ada: Row<TestClient, "user">;
}

// A graph pooling one user over a definition whose author slot is native input creating a user of its
// own: a state naming a factory of the pooled model replaces that input, so a second user row is what
// tells a state that took from one that never ran.
async function nativeAuthored(): Promise<NativeAuthored> {
  const harness = await factorioHarness();
  const { f, users } = harness;
  const ada = await users.create();
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: { create: { email: `${uid}@example.com` } }, editor: users }),
    states: { credited: { author: users } },
  });

  return { harness, posts: posts.recycle("user", ada), ada };
}

test("a factory a declared state names loses to the pool, exactly as a definition default does", async () => {
  const { harness, posts, ada } = await nativeAuthored();

  const post = await posts.credited().create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

test("a factory an inline state names loses to the pool too", async () => {
  const { harness, posts, ada } = await nativeAuthored();

  const post = await posts.state({ author: harness.users }).create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([ada.id, ada.id, 1]);
});

// Prisma's own relation input is no factory, and the pool stands in for factories alone: the author
// this definition names is created where a factory in that slot would have been drawn.
test("native relation input under a pool creates the record it names, the slots around it drawn", async () => {
  const { harness, posts, ada } = await nativeAuthored();

  const post = await posts.create();

  await createdThenDrawn(harness, post, ada);
});

test("for(row) stands as it always did, a row being no record the pool could stand in for", async () => {
  const { harness, posts, ada } = await pooling();
  const grace = await harness.users.create({ name: "Grace" });

  const post = await posts.for(grace, "author").create();

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([grace.id, ada.id, 2]);
});

test("an override holding a row stands as it always did", async () => {
  const { harness, posts, ada } = await pooling();
  const grace = await harness.users.create({ name: "Grace" });

  const post = await posts.create({ author: grace });

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
  const { harness, comments, ada } = await pooling();

  const comment = await comments.for(harness.posts, "post").create();

  await createdThenDrawnBelow(harness, comment, ada);
});

test("the pool reaches the graph below an override naming a factory", async () => {
  const { harness, comments, ada } = await pooling();

  const comment = await comments.create({ post: harness.posts });

  await createdThenDrawnBelow(harness, comment, ada);
});

test("a has() child factory draws its own relation defaults from the pool", async () => {
  const harness = await editedPosts();
  const { prisma, users, posts } = harness;
  const ada = await users.create();

  const author = await users.recycle("user", ada).has(posts, "posts").create();
  const post = await prisma.post.findFirstOrThrow({ where: { authorId: author.id } });

  await expect(slotsAndUsers(harness, post)).resolves.toStrictEqual([author.id, ada.id, 2]);
});

// Every slot the graph filled holds a row of the pool: an id the pool never carried — and a slot left
// empty — stands out as an entry of its own.
function strays(picks: readonly (number | null)[], ids: readonly number[]): (number | null)[] {
  return picks.filter((id) => id === null || !ids.includes(id));
}

test("a list pool spreads over every row it holds, calls merged, and picks nothing else", async () => {
  const { prisma, users, posts } = await editedPosts({ seed: 7 });
  const pool = await users.count(3).create();
  const ids = pool.map((user) => user.id);

  const rows = await posts.count(6).recycle("user", pool.slice(0, 2)).recycle("user", pool.slice(2)).create();
  const picks = rows.flatMap((post) => [post.authorId, post.editorId]);

  expect(strays(picks, ids)).toStrictEqual([]);
  expect(new Set(picks).size).toBe(ids.length);
  await expect(prisma.user.count()).resolves.toBe(3);
});

test("a factory pooling rows of its own keeps them when the graph above it hands its pool down", async () => {
  const harness = await editedPosts({ seed: 7 });
  const { prisma, f, users } = harness;
  const ada = await users.create();
  const grace = await users.create({ name: "Grace" });
  const posts = harness.posts.recycle("user", grace);
  const comments = f.define("comment", { definition: ({ uid }) => ({ body: uid, post: posts }) });

  const rows = await comments.count(6).recycle("user", ada).create();
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
  const { prisma, users, posts } = await editedPosts({ seed });
  const pool = await users.count(3).create();
  const rows = await posts.count(4).recycle("user", pool).create();

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
  const { harness, posts, ada } = await pooling();

  const rows = await posts.count(2).create();

  expect(rows.flatMap((post) => [post.authorId, post.editorId])).toStrictEqual([ada.id, ada.id, ada.id, ada.id]);
  await expect(harness.prisma.user.count()).resolves.toBe(1);
});

// Nothing the graph writes joins the pool: the authors these records create never turn up in a later
// pick, however many of them exist by the time the next slot is filled.
test("rows the graph creates are never drawn later, the pool standing as it was handed over", async () => {
  const { harness, posts, ada } = await pooling();

  const rows = await posts.count(4).create({ author: harness.users });

  expect(new Set(rows.map((post) => post.editorId))).toStrictEqual(new Set([ada.id]));
  await expect(harness.prisma.user.count()).resolves.toBe(5);
});

interface Attaching {
  harness: Harness;
  authors: Factory<TestClient, "user">;
  pool: Row<TestClient, "post">[];
  ids: number[];
}

// Posts already written and a user factory recycling them, which is where every `has` case starts.
// The harness's post factory brings an author of its own, so the users standing behind the pool are no
// part of what these tests count.
async function attaching(rows: number): Promise<Attaching> {
  const harness = await factorioHarness({ seed: 7 });
  const pool = await harness.posts.count(rows).create();

  return { harness, authors: harness.users.recycle("post", pool), pool, ids: pool.map((post) => post.id) };
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
  const writes = await userWrites(harness, (users) => users.recycle("post", pool).has(children, "posts"));

  return writes.map((data) => connectedIds(data, "posts"));
}

test("has(factory) over a pooled model connects a pooled row rather than creating a record", async () => {
  const { harness, authors, ids } = await attaching(1);

  const author = await authors.has(harness.posts, "posts").create();

  await expect(authoredBy(harness.prisma, author.id)).resolves.toStrictEqual(ids);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// The picks a batch of children made over a pool of posts: every one of them a row the pool holds,
// and the pool left exactly as many rows as it was handed.
async function drawnOver(rows: number, children: number): Promise<number[]> {
  const target = await attaching(rows);
  const picks = (await drawnIds(target, target.harness.posts.count(children))).flat();

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
  attach: (posts: Factory<TestClient, "post">, children: ChildTags) => Factory<TestClient, "post", unknown>,
): Promise<PerRecord> {
  const harness = await factorioHarness({ seed: 7 });
  const tag = await harness.tags.create();
  const { client, written: writes } = recording(harness.prisma, "post");

  await attach(harness.posts.recycle("tag", tag), harness.tags.count(2)).count(2).using(client).create();

  return {
    connected: writes.map((data) => connectedIds(data, "tags")),
    drawn: tag.id,
    written: await harness.prisma.tag.count(),
  };
}

// The cadence every `has` layer keeps: children belong to one parent record, so a batch of parents
// draws a batch of children each.
test("a pooled has() child is drawn per parent record, the whole batch of them", async () => {
  const { connected, drawn, written } = await drawnPerRecord((posts, tags) => posts.has(tags));

  expect(connected).toStrictEqual([
    [drawn, drawn],
    [drawn, drawn],
  ]);
  expect(written).toBe(1);
});

// A connect into a relation field backed by a required foreign key re-homes the child, rewriting the
// column the pooled copy still carries: the next parent record drawing that row matches it on scalars
// the database no longer holds. Tracked as issue #47, which leaves a pooled row of such a relation good
// for one parent record. The README paragraph naming #47 stands or falls with this test. The cadence
// tests run over the implicit many-to-many alone, so this route wants a positive cadence test again
// once #47 is fixed.
test("a pooled has() child fails the second parent record, its foreign key rewritten by the first", async () => {
  const { harness, authors } = await attaching(1);

  await expect(authors.count(2).has(harness.posts, "posts").create()).rejects.toThrow(
    "The required connected records were not found",
  );
});

// A caller pools rows it loaded itself, and an `include`d relation is no field to match a record on.
test("a pooled has() child loaded with include connects on its scalars, the loaded relation left out", async () => {
  const harness = await factorioHarness({ seed: 7 });
  const loaded = await postWithComments(harness);
  const { comments, ...scalars } = loaded;

  const data = await userCreateData(harness, (users) => users.recycle("post", loaded).has(harness.posts, "posts"));

  expect(comments).toStrictEqual([]);
  expect(data.posts).toStrictEqual({ connect: [scalars] });
});

// A chain batched to no records asks the pool for nothing, and a relation field with nothing to
// connect stays unwritten — the same reading `has` gives a list of no children.
test("has(factory.count(0)) over a pooled model draws nothing and leaves the relation field unwritten", async () => {
  const { harness, pool } = await attaching(1);

  const data = await userCreateData(harness, (users) =>
    users.recycle("post", pool).has(harness.posts.count(0), "posts"),
  );

  expect(Object.keys(data)).toStrictEqual(["email", "name"]);
  await expect(harness.prisma.post.count()).resolves.toBe(1);
});

// A drawn child stands for a record that exists already, so the factory naming it never runs — no
// definition of its own, and no state either.
test("a pooled has() child factory is never evaluated", async () => {
  const { harness, authors, pool } = await attaching(1);
  const evaluated: string[] = [];
  const posts = harness.f.define("post", {
    definition: ({ uid }) => {
      evaluated.push(uid);
      return { title: uid, author: harness.users };
    },
  });

  const author = await authors.has(posts, "posts").create();

  expect(evaluated).toStrictEqual([]);
  await expect(authoredBy(harness.prisma, author.id)).resolves.toStrictEqual(pool.map((post) => post.id));
});

// Both ends of an implicit many-to-many hold many records, so a pooled child reaches it through the
// same `has` layer a created one does, and the picks land in one join table row each.
test("a pooled has() child joins the parent across an implicit many-to-many", async () => {
  const { prisma, posts, tags } = await factorioHarness({ seed: 7 });
  const tag = await tags.create();

  const post = await posts.recycle("tag", tag).has(tags.count(2)).create();
  const joined = await prisma.post.findUniqueOrThrow({ where: { id: post.id }, include: { tags: true } });

  expect(joined.tags.map((row) => row.id)).toStrictEqual([tag.id]);
  await expect(prisma.tag.count()).resolves.toBe(1);
});

// A drawn row lands in the parent's own create, which is a call site of its own: the tripwire above
// reaches the same compound key through the rows a caller hands `has`, and neither route stands in
// for the other. Both hold until #41 is fixed, and the README paragraph naming it rests on the pair.
test("a pooled join-model row fails on its compound key too, drawn into the parent's own create", async () => {
  const { harness, membership } = await joined();

  await expect(harness.users.recycle("membership", membership).has(harness.memberships).create()).rejects.toThrow(
    "Expected MembershipWhereUniqueInput",
  );
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

  const post = (await attach(harness, harness.comments.count(records))
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
  const { attached, connected, written, drawn } = await pooledChildren(2, (harness, comments) =>
    harness.posts.state({ comments }),
  );

  expect(connected).toStrictEqual([[drawn, drawn]]);
  expect(attached).toStrictEqual([drawn]);
  expect(written).toBe(2);
});

test("a to-many default a definition names loses to the pool the same way", async () => {
  const { connected, written, drawn } = await pooledChildren(2, ({ f, users }, comments) =>
    f.define("post", { definition: ({ uid }) => ({ title: uid, author: users, comments }) }),
  );

  expect(connected).toStrictEqual([[drawn, drawn]]);
  expect(written).toBe(2);
});

// A state is a state wherever it was declared: the pool beats the one the config names exactly as it
// beats the one a call adds.
test("a to-many default a config-declared state names loses to the pool too", async () => {
  const { connected, written, drawn } = await pooledChildren(2, ({ f, users }, comments) =>
    f
      .define("post", {
        definition: ({ uid }) => ({ title: uid, author: users }),
        states: { commented: { comments } },
      })
      .commented(),
  );

  expect(connected).toStrictEqual([[drawn, drawn]]);
  expect(written).toBe(2);
});

test("a to-many default the caller names outright beats the pool and creates its children", async () => {
  const { harness, first } = await spare();

  const post = await harness.posts.recycle("comment", first).create({ comments: harness.comments.count(2) });
  const held = await attachedTo(harness.prisma, post.id, "comments");

  expect(held).toHaveLength(2);
  expect(held).not.toContain(first.id);
  await expect(harness.prisma.comment.count()).resolves.toBe(4);
});

// A chain batched to no records asks the pool for nothing, and a relation field with nothing to connect
// stays unwritten — the same reading a pooled `has` layer gives a batch of none.
test("a pooled to-many default batched to no records draws nothing and leaves the relation field unwritten", async () => {
  const { keys, written } = await pooledChildren(0, (harness, comments) => harness.posts.state({ comments }));

  expect(keys).toStrictEqual([["title", "author"]]);
  expect(written).toBe(2);
});

// The cadence a to-many default keeps, which is `for()`'s deliberate opposite: children belong to one
// record, so every record of a batch draws a set of its own.
test("a pooled to-many default is drawn per parent record, the whole batch of them", async () => {
  const { connected, drawn, written } = await drawnPerRecord((posts, tags) => posts.state({ tags }));

  expect(connected).toStrictEqual([
    [drawn, drawn],
    [drawn, drawn],
  ]);
  expect(written).toBe(1);
});

// Explicitness covers the slot the call named and nothing under it: the post the override names is
// created rather than drawn, and the editor that post reaches for is drawn all the same.
test("the pool reaches the graph below a to-many default the caller named outright", async () => {
  const { harness, posts, ada } = await pooling();
  const standing = await posts.create();

  const user = await harness.users.recycle("post", standing).recycle("user", ada).create({ posts: harness.posts });
  const authored = await harness.prisma.post.findMany({ where: { authorId: user.id } });

  expect(authored.map((post) => post.editorId)).toStrictEqual([ada.id]);
  await expect(harness.prisma.post.count()).resolves.toBe(2);
  await expect(harness.prisma.user.count()).resolves.toBe(2);
});

// Both ends of an implicit many-to-many hold many records, so a to-many default reaches it through the
// same picks a `has` layer draws, and they land in one join table row each.
test("a pooled to-many default joins the parent across an implicit many-to-many", async () => {
  const { prisma, posts, tags } = await factorioHarness({ seed: 7 });
  const tag = await tags.create();

  const post = await posts
    .recycle("tag", tag)
    .state({ tags: tags.count(2) })
    .create();

  await expect(attachedTo(prisma, post.id, "tags")).resolves.toStrictEqual([tag.id]);
  await expect(prisma.tag.count()).resolves.toBe(1);
});

// The three ways a graph reaches a record of another model, in one create: the author the definition
// names, the editor a state names, and the tag a `has` layer brings. Every one of them is drawn.
test("the pool fills a definition slot, a state slot and a has() child of one graph alike", async () => {
  const { prisma, users, posts, tags } = await factorioHarness({ seed: 7 });
  const ada = await users.create();
  const tag = await tags.create();

  const post = await posts.recycle("user", ada).recycle("tag", tag).state({ editor: users }).has(tags).create();
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
  const ada = await harness.users.using(target).create();

  await rolledBack(target, (tx) => harness.comments.recycle("user", ada).using(tx).create(), [1, 1, 1]);

  await leftBehind(harness, target, [1, 0, 0]);
});

// A drawn child joins the parent's own create rather than being created after it, so the client that
// create runs on is the one its connect list is resolved against.
test("using(tx) covers a has() layer drawing from the pool, and a rollback drops the parent", async () => {
  const harness = await factorioHarness();
  const target = await disposableClient();
  const post = await harness.posts.using(target).create();

  await rolledBack(
    target,
    (tx) => harness.users.recycle("post", post).has(harness.posts, "posts").using(tx).create(),
    [2, 1, 0],
  );

  await leftBehind(harness, target, [1, 1, 0]);
});

interface Notified {
  seen: Row<TestClient, "user">[];
  users: Factory<TestClient, "user">;
}

// The rows a config-declared callback was handed, in the order it was handed them.
function notifiedUsers(f: Factorio<TestClient>): Notified {
  const seen: Row<TestClient, "user">[] = [];
  const users = f.define("user", {
    definition: userDefinition,
    afterCreating: (user) => {
      seen.push(user);
    },
  });

  return { seen, users };
}

test("a config-declared afterCreating fires with the created row", async () => {
  const { f } = await factorioHarness();
  const { seen, users } = notifiedUsers(f);

  const ada = await users.create();

  expect(seen).toStrictEqual([ada]);
});

test("count(3) fires the callback once per row, each with the row it was created for", async () => {
  const { f } = await factorioHarness();
  const { seen, users } = notifiedUsers(f);

  const rows = await users.count(3).create();

  expect(seen).toStrictEqual(rows);
  expect(seen).toHaveLength(3);
});

test("count(0) creates no record and fires no callback", async () => {
  const { f } = await factorioHarness();
  const { seen, users } = notifiedUsers(f);

  const rows = await users.count(0).create();

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
  const { users } = await factorioHarness();
  const seen: Row<TestClient, "user">[] = [];

  const ada = await users
    .afterCreating((user) => {
      seen.push(user);
    })
    .create();

  expect(seen).toStrictEqual([ada]);
});

test("a config-declared callback runs before the fluent ones, which run in registration order", async () => {
  const { f } = await factorioHarness();
  const log: string[] = [];
  const users = f.define("user", { definition: userDefinition, afterCreating: logging(log, "config") });

  await users.afterCreating(logging(log, "first")).afterCreating(logging(log, "second")).create();

  expect(log).toStrictEqual(["config", "first", "second"]);
});

test("each callback finishes before the next one starts", async () => {
  const { users } = await factorioHarness();
  const log: string[] = [];

  await users.afterCreating(yielding(log, "first")).afterCreating(yielding(log, "second")).create();

  expect(log).toStrictEqual(["first in", "first out", "second in", "second out"]);
});

test("afterCreating leaves the factory it was called on untouched", async () => {
  const { users } = await factorioHarness();
  const log: string[] = [];
  const notified = users.afterCreating(logging(log, "once"));

  await users.create();
  await notified.create();

  expect(log).toStrictEqual(["once"]);
});

test("afterCreating keeps the batch and the states, whichever order the chain was written in", async () => {
  const { f } = await factorioHarness();
  const log: string[] = [];
  const users = statefulUsers(f);

  const one = await users.afterCreating(logging(log, "before")).suspended().create();
  const many = await users.count(2).afterCreating(logging(log, "after")).create();

  expect(one.name).toBeNull();
  expect(many).toHaveLength(2);
  expect(log).toStrictEqual(["before", "after", "after"]);
});

function loggingUsers(f: Factorio<TestClient>, log: string[], name: string): Factory<TestClient, "user"> {
  return f.define("user", { definition: userDefinition, afterCreating: logging(log, name) });
}

// A row already standing, which is what a pool hands over: written straight through the client, so no
// factory ran for it and the log is empty before the graph under test does anything.
async function standingUser(prisma: TestClient): Promise<Row<TestClient, "user">> {
  return prisma.user.create({ data: { email: "standing@example.com", name: "Ada" } });
}

test("a parent's callback sees its has() children already written", async () => {
  const { f, posts } = await factorioHarness();
  const counted: number[] = [];
  const users = f.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      counted.push(await client.post.count({ where: { authorId: user.id } }));
    },
  });

  await users.has(posts.count(2), "posts").create();

  expect(counted).toStrictEqual([2]);
});

// The whole shape in one graph: a parent the definition embeds, two children, and the record between
// them. A child counts the posts standing when its own callback fires, and the record counts the
// children it holds, so the log pins the record as written ahead of the children — a child created
// before it would have brought the post its own definition names, and counted two.
async function firingOrder(
  attach: (posts: Factory<TestClient, "post">, children: ChildComments) => Factory<TestClient, "post">,
): Promise<string[]> {
  const { f, posts: standing } = await factorioHarness();
  const log: string[] = [];
  const users = loggingUsers(f, log, "parent");
  const comments = f.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: standing }),
    afterCreating: async (comment, { client }) => {
      log.push(`child, ${String(await client.post.count())} posts written`);
    },
  });
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    afterCreating: async (post, { client }) => {
      log.push(`record sees ${String(await client.comment.count({ where: { postId: post.id } }))} children`);
    },
  });

  await attach(posts, comments.count(2)).create();

  return log;
}

const wholeGraph = ["parent", "child, 1 posts written", "child, 1 posts written", "record sees 2 children"];

test("a graph fires the parent's callbacks, then each child's own, then the record's last", async () => {
  await expect(firingOrder((posts, children) => posts.has(children, "comments"))).resolves.toStrictEqual(wholeGraph);
});

// A record a to-many default brings runs a `write` of its own, so its callbacks fire exactly where a
// `has` child's do, and the whole graph reads the same either way.
test("a to-many default fires each child's own callbacks between the record and the record's own", async () => {
  await expect(firingOrder((posts, children) => posts.state({ comments: children }))).resolves.toStrictEqual(
    wholeGraph,
  );
});

// One parent answers the whole batch, so its own create runs once and so do the callbacks behind it.
test("a for() parent's callbacks fire once per create() call rather than once per record", async () => {
  const { f, posts } = await factorioHarness();
  const log: string[] = [];
  const users = loggingUsers(f, log, "user");

  const written = await posts.count(3).for(users, "author").create();

  expect(written).toHaveLength(3);
  expect(log).toStrictEqual(["user"]);
});

// The second create runs the same graph with no pool: it fires once, which is what shows the first
// create fired none rather than the callback never having been registered.
test("a row drawn from the pool into an embedded slot fires no callback", async () => {
  const { prisma, f } = await factorioHarness();
  const log: string[] = [];
  const users = loggingUsers(f, log, "user");
  const posts = f.define("post", { definition: ({ uid }) => ({ title: uid, author: users }) });
  const ada = await standingUser(prisma);

  await posts.recycle("user", ada).create();
  await posts.create();

  expect(log).toStrictEqual(["user"]);
});

// The standing post is created through the factory, so the one entry on the log is its own: the two
// records the `has` layer would have created were drawn from the pool instead and fired nothing.
test("a has() child factory drawn from the pool fires no callback", async () => {
  const { f, users } = await factorioHarness();
  const log: string[] = [];
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    afterCreating: logging(log, "post"),
  });
  const standing = await posts.create();

  await users.recycle("post", standing).has(posts.count(2), "posts").create();

  expect(log).toStrictEqual(["post"]);
});

// The standing comment is created through the factory, so the one entry on the log is its own: the two
// records the to-many default would have created were drawn from the pool instead and fired nothing.
test("a to-many default drawn from the pool fires no callback", async () => {
  const { f, posts } = await factorioHarness();
  const log: string[] = [];
  const comments = f.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: posts }),
    afterCreating: logging(log, "comment"),
  });
  const standing = await comments.create();

  await posts
    .recycle("comment", standing)
    .state({ comments: comments.count(2) })
    .create();

  expect(log).toStrictEqual(["comment"]);
});

// `for()` names the caller's own parent, which the pool never stands in for, so that record is created
// like any other and the callbacks behind it run.
test("a for() parent under a pool of its model is still created, and still fires", async () => {
  const { prisma, f, posts } = await factorioHarness();
  const log: string[] = [];
  const users = loggingUsers(f, log, "user");
  const ada = await standingUser(prisma);

  await posts.recycle("user", ada).for(users, "author").create();

  expect(log).toStrictEqual(["user"]);
  await expect(prisma.user.count()).resolves.toBe(2);
});

test("a throwing callback rejects create(), leaving the record it followed committed", async () => {
  const { prisma, f } = await factorioHarness();
  const failed = new Error("the callback failed");
  const users = f.define("user", {
    definition: userDefinition,
    afterCreating: () => {
      throw failed;
    },
  });

  await expect(users.create()).rejects.toBe(failed);
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
  const users = harness.f.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "audit", author: { connect: { id: user.id } } } });
      inside.push(await client.post.count());
      throw failed;
    },
  });

  const outcome: unknown = await target
    .$transaction((tx) => users.has(harness.posts.count(2), "posts").using(tx).create())
    .catch((error: unknown) => error);

  expect(outcome).toBe(failed);
  expect(inside).toStrictEqual([3]);
  await leftBehind(harness, target, [0, 0, 0]);
});

// Bootstrapped on one database and redirected to another: the post reaches the second only because
// the callback wrote through the client handed to it rather than through the one it could close over.
test("a callback writes through the client the chain writes through", async () => {
  const { prisma, f } = await factorioHarness();
  const elsewhere = await disposableClient();
  const users = f.define("user", {
    definition: userDefinition,
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "welcome", author: { connect: { id: user.id } } } });
    },
  });

  await users.using(elsewhere).create();

  await expect(elsewhere.post.count()).resolves.toBe(1);
  await expect(prisma.post.count()).resolves.toBe(0);
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function recycleCheckedByTheCompiler(
  users: Factory<TestClient, "user">,
  posts: Factory<TestClient, "post">,
  userRow: Row<TestClient, "user">,
  stateful: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
): void {
  // Held rather than written inline: a row loaded with `include` carries its relations alongside its
  // scalars, and excess property checking reaches a fresh object literal only.
  const included = { ...userRow, posts: [], edited: [] };

  void users.recycle("user", userRow).create();
  void users.recycle("user", [userRow]).create();
  void users.recycle("user", included).create();
  void posts.recycle("user", userRow).recycle("post", []).create();

  expectTypeOf(users.recycle("user", userRow)).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(users.count(2).recycle("user", userRow).create()).resolves.toEqualTypeOf<Row<TestClient, "user">[]>();
  expectTypeOf(stateful.recycle("user", userRow).suspended()).toEqualTypeOf<typeof stateful>();
  expectTypeOf(stateful.suspended().recycle("user", userRow)).toEqualTypeOf<typeof stateful>();

  // @ts-expect-error a row missing a scalar the named model requires
  void users.recycle("user", { id: 1 });
  // @ts-expect-error a row of a model other than the one named
  void users.recycle("post", userRow);
  // @ts-expect-error a model the client does not carry
  void users.recycle("author", userRow);
  // @ts-expect-error a list holding a value that is no row of the named model
  void users.recycle("user", [userRow, 42]);
}

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function relationsCheckedByTheCompiler(
  posts: Factory<TestClient, "post">,
  comments: Factory<TestClient, "comment">,
  users: Factory<TestClient, "user">,
  userRow: Row<TestClient, "user">,
  postRow: Row<TestClient, "post">,
  commentRow: Row<TestClient, "comment">,
  stateful: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
  draftable: Factory<TestClient, "post", Row<TestClient, "post">, { drafted: unknown }>,
  tags: Factory<TestClient, "tag">,
  tagRow: Row<TestClient, "tag">,
  teams: Factory<TestClient, "team">,
  memberships: Factory<TestClient, "membership">,
): void {
  void posts.for(users, "author").create();
  void posts.for(userRow, "editor").create();
  void posts.for(stateful, "author").create();
  void posts.for(stateful.suspended(), "author").create();
  void comments.for(posts).create();
  void comments.for(postRow).create();

  expectTypeOf(posts.for(users, "author")).toEqualTypeOf<Factory<TestClient, "post">>();
  expectTypeOf(posts.count(2).for(users, "author").create()).resolves.toEqualTypeOf<Row<TestClient, "post">[]>();

  // @ts-expect-error the relation field is required where the model pair shares several
  void posts.for(users);
  // @ts-expect-error a row infers the model it belongs to, so this pair shares several too
  void posts.for(userRow);
  // @ts-expect-error no belongs-to relation reaches a user from a comment
  void comments.for(users, "post");
  // @ts-expect-error no belongs-to relation reaches a user from a comment, name left out
  void comments.for(users);
  // @ts-expect-error the one relation reaching a comment from a post holds many records
  void posts.for(comments, "comments");
  // @ts-expect-error a relation field the model pair does not share
  void posts.for(users, "illustrator");
  // @ts-expect-error a value that is neither a factory nor a row
  void posts.for(42, "author");
  // @ts-expect-error a batched factory creates a row each, so it stands for no one parent
  void posts.for(users.count(3), "author");

  void users.has(posts, "posts").create();
  void users.has(draftable, "posts").create();
  void users.has(draftable.drafted(), "posts").create();
  void users.has(posts.count(3), "edited").create();
  void users.has(postRow, "posts").create();
  void users.has([postRow], "posts").create();
  void posts.has(comments).create();
  void posts.has(commentRow).create();
  void users.has(posts, "posts", { inverse: "author" }).create();
  void posts.has(comments, { inverse: "post" }).create();
  // The option is declared as skippable rather than merely optional, so a name held elsewhere reaches
  // the call whether or not it was found.
  void users.has(posts, "posts", { inverse: undefined }).create();

  expectTypeOf(users.has(posts, "posts")).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(users.count(2).has(posts, "posts").create()).resolves.toEqualTypeOf<Row<TestClient, "user">[]>();

  // @ts-expect-error the relation field is required where the model pair shares several
  void users.has(posts);
  // @ts-expect-error a row infers the model it belongs to, so this pair shares several too
  void users.has(postRow);
  // @ts-expect-error the one relation reaching a post from a comment holds one record
  void comments.has(posts, "post");
  // @ts-expect-error the one relation reaching a post from a comment holds one record, name left out
  void comments.has(posts);
  // @ts-expect-error no relation of any arity reaches a user from a comment
  void comments.has(users);
  // @ts-expect-error the relations reaching a user from a post hold one record each
  void posts.has(users, "author");
  // @ts-expect-error a relation field the model pair does not share
  void users.has(posts, "illustrated");
  // @ts-expect-error a value that is neither a factory, a row, nor a list of rows
  void users.has(42, "posts");
  // @ts-expect-error an option the escape hatch does not carry
  void users.has(posts, "posts", { inverze: "author" });
  // @ts-expect-error the options stand alone only where the relation field may be left out
  void users.has(posts, { inverse: "author" });

  void posts.has(tags).create();
  void posts.has(tags.count(3), "tags").create();
  void posts.has([tagRow]).create();
  void tags.has(posts).create();
  void tags.has(posts.count(2), "posts").create();

  // Both ends of an implicit many-to-many hold many records, so the pair has no belongs-to side at
  // all and `has` is the only way in — from whichever end reads better.
  // @ts-expect-error no belongs-to relation reaches a tag from a post
  void posts.for(tags);
  // @ts-expect-error naming the field does not make one, the field being a list at both ends
  void posts.for(tags, "tags");
  // @ts-expect-error no belongs-to relation reaches a post from a tag either
  void tags.for(posts);
  // @ts-expect-error a row names the same pair, and answers the same way
  void posts.for(tagRow);

  void users.has(memberships, "memberships").create();
  void users.has(memberships.count(2)).create();
  void teams.has(memberships).create();
  void memberships.for(users).create();
  void memberships.for(userRow).create();
  void memberships.for(teams).create();

  // The datamodel holds no relation between the two far models of an explicit many-to-many, so the
  // pair answers at neither arity and the join model's factory is the only way across.
  // @ts-expect-error no has-many relation reaches a team from a user
  void users.has(teams);
  // @ts-expect-error no belongs-to relation reaches a team from a user either
  void users.for(teams);
}

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function callbacksCheckedByTheCompiler(
  f: Factorio<TestClient>,
  users: Factory<TestClient, "user">,
  stateful: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
): void {
  const noted = (): void => undefined;

  void users.afterCreating(noted).create();
  // Whatever a callback hands back is awaited and discarded, so the concise form of an arrow — whose
  // return type is the call's own — stands here as readily as a block body returning nothing.
  void users.afterCreating(async (user, { client }) => client.post.count({ where: { authorId: user.id } })).create();
  void f.define("user", { definition: userDefinition, afterCreating: noted });

  expectTypeOf(users.afterCreating(noted)).toEqualTypeOf<Factory<TestClient, "user">>();
  expectTypeOf(users.count(2).afterCreating(noted).create()).resolves.toEqualTypeOf<Row<TestClient, "user">[]>();
  expectTypeOf(stateful.afterCreating(noted).suspended()).toEqualTypeOf<typeof stateful>();
  expectTypeOf(stateful.suspended().afterCreating(noted)).toEqualTypeOf<typeof stateful>();

  // @ts-expect-error the row is the factory's own model, so a column another model declares is not on it
  void users.afterCreating((user) => user.slug);
  // @ts-expect-error the context carries the client and nothing else
  void users.afterCreating((user, { pool }) => pool);
  // @ts-expect-error a value that is no callback at all
  void users.afterCreating(42);
  // @ts-expect-error the config key takes one callback rather than a list of them
  void f.define("user", { definition: userDefinition, afterCreating: [noted] });
}
