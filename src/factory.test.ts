import { expect, expectTypeOf, test, vi } from "vitest";
import { initPrismaFactorio, type Factorio } from "./factorio.js";
import type { EvaluationContext, Factory, FactoryConfig, StateContext } from "./factory.js";
import type { Row } from "./prisma.js";
import { disposableClient, factorioHarness, userDefinition, type Harness } from "./tests/factorio.js";
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

  for (const name of ["prisma-factorio.factory", "prisma-factorio.rebind"]) {
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
    'The model "post" has no relation field "illustrator" pointing at "user". Pass one of "author", "editor".',
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

// The graph is expected inside the transaction and gone once it rolls back, which the counts on
// `tx` and the counts the caller makes afterwards pin from both sides.
async function rolledBack(target: TestClient, run: (tx: Transaction) => Promise<unknown>): Promise<void> {
  const rollback = new Error("rollback");

  const outcome: unknown = await target
    .$transaction(async (tx) => {
      await run(tx);
      await expect(tx.user.count()).resolves.toBe(1);
      await expect(tx.post.count()).resolves.toBe(1);
      throw rollback;
    })
    .catch((error: unknown) => error);

  expect(outcome).toBe(rollback);
}

// The harness bootstraps on a database of its own, so a parent created through the bootstrap client
// rather than through `tx` survives the rollback and is counted there.
async function withoutOrphans(create: (harness: Harness, tx: Transaction) => Promise<unknown>): Promise<void> {
  const harness = await factorioHarness();
  const target = await disposableClient();

  await rolledBack(target, (tx) => create(harness, tx));

  await expect(target.user.count()).resolves.toBe(0);
  await expect(target.post.count()).resolves.toBe(0);
  await expect(harness.prisma.user.count()).resolves.toBe(0);
  await expect(harness.prisma.post.count()).resolves.toBe(0);
}

test("for() creates the parent through the client using() named, so a rollback drops it too", async () => {
  await withoutOrphans(({ posts, users }, tx) => posts.for(users, "author").using(tx).create());
});

test("a relation default in a definition is created through the client using() named", async () => {
  await withoutOrphans(({ posts }, tx) => posts.using(tx).create());
});

test("a relation default reaching through several models runs every level on that client", async () => {
  await withoutOrphans(({ comments }, tx) => comments.using(tx).create());
});

test("a parent factory naming a client of its own is created through it, not the resolving one", async () => {
  const { posts, users } = await factorioHarness();
  const target = await disposableClient();
  let authors: Record<string, unknown>[] = [];

  await rolledBack(target, (tx) => {
    const { client, written } = recording(tx, "user");
    authors = written;

    return posts.for(users.using(client), "author").using(tx).create();
  });

  expect(authors).toHaveLength(1);
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function relationsCheckedByTheCompiler(
  posts: Factory<TestClient, "post">,
  comments: Factory<TestClient, "comment">,
  users: Factory<TestClient, "user">,
  userRow: Row<TestClient, "user">,
  postRow: Row<TestClient, "post">,
  stateful: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
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
}
