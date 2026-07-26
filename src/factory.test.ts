import { expect, expectTypeOf, onTestFinished, test, vi, type MockedFunction } from "vitest";
import { inverseRelationField } from "./datamodel.js";
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

  for (const name of ["prisma-factorio.factory", "prisma-factorio.rebind", "prisma-factorio.parent"]) {
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

test("a factory with no relation value to resolve never reads the client's relation metadata", async () => {
  const { prisma } = await factorioHarness();
  const delegates = initPrismaFactorio({ user: prisma.user });

  const user = await delegates.define("user", { definition: userDefinition }).create();

  expect(user.name).toBe("Ada");
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

async function userCreateData(
  harness: Harness,
  attach: (users: Factory<TestClient, "user">) => Factory<TestClient, "user">,
): Promise<Record<string, unknown>> {
  const { client, written } = recording(harness.prisma, "user");

  await attach(harness.users.using(client)).create();

  return written[0] ?? {};
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

// The join model's only unique constraint is its compound key, which Prisma exposes under the single
// generated name `userId_teamId` and demands under that name; the flat scalars a row carries satisfy
// no `WhereUniqueInput`. Tracked as issue #41, whose workaround is passing native relation input,
// `{ connect: { userId_teamId: … } }`. The README paragraph naming #41 stands or falls with this test.
test("connecting an existing join-model row fails on its compound key", async () => {
  const { users, memberships } = await factorioHarness();
  const ada = await users.create();
  const membership = await memberships.for(ada).create();

  await expect(users.has([membership], "memberships").create()).rejects.toThrow("Expected MembershipWhereUniqueInput");
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
