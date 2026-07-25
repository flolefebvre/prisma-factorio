/**
 * Design-verification suite: every claim the design proposal makes about
 * runtime behavior or typing is exercised here against a real sqlite database
 * and the real generated Prisma 7 client.
 */
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/client.ts";
import {
  CommentFactory,
  factorio,
  MembershipFactory,
  PostFactory,
  TagFactory,
  TeamFactory,
  UserFactory,
} from "./factories.ts";

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: `file:${path.join(import.meta.dirname, "dev.db")}`,
  }),
});

beforeAll(() => {
  factorio.use(prisma);
});

beforeEach(async () => {
  await prisma.membership.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.post.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

describe("basics", () => {
  it("creates a record with definition attributes and db defaults", async () => {
    const user = await UserFactory.create();
    expect(user.id).toBeTypeOf("number");
    expect(user.role).toBe("user");
    expect(user.suspended).toBe(false);
    expect(await prisma.user.count()).toBe(1);
    expectTypeOf(user.email).toEqualTypeOf<string>();
    expectTypeOf(user.suspended).toEqualTypeOf<boolean>();
  });

  it("applies named states, inline states, and overrides (last wins)", async () => {
    const user = await UserFactory.suspended()
      .withRole("admin")
      .state({ name: "Stated" })
      .create({ name: "Overridden" });
    expect(user.suspended).toBe(true);
    expect(user.role).toBe("admin");
    expect(user.name).toBe("Overridden");
  });

  it("count(n) creates n records and types the result as an array", async () => {
    const users = await UserFactory.count(3).create();
    expect(users).toHaveLength(3);
    expectTypeOf(users).toBeArray();
    const one = await UserFactory.create();
    expectTypeOf(one).not.toBeArray();
  });

  it("sequence() cycles values across the batch", async () => {
    const users = await UserFactory.count(4).sequence({ role: "a" }, { role: "b" }).create();
    expect(users.map((u) => u.role)).toEqual(["a", "b", "a", "b"]);
  });

  it("make() resolves attributes without touching the database", async () => {
    const data = UserFactory.suspended().make();
    expect(data.suspended).toBe(true);
    expect(data.email).toContain("@example.com");
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("belongs-to relations", () => {
  it("auto-creates required parents declared in the definition", async () => {
    const post = await PostFactory.create();
    expect(post.authorId).toBeTypeOf("number");
    expect(await prisma.user.count()).toBe(1);
  });

  it("for(name, factory) nests a customized parent", async () => {
    const post = await PostFactory.for("author", UserFactory.withRole("editor")).create();
    const author = await prisma.user.findUniqueOrThrow({
      where: { id: post.authorId },
    });
    expect(author.role).toBe("editor");
  });

  it("for(name, record) connects an existing record via the id convention", async () => {
    const user = await UserFactory.create();
    const posts = await PostFactory.count(3).for("author", user).create();
    expect(posts.map((p) => p.authorId)).toEqual([user.id, user.id, user.id]);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("has-many relations", () => {
  it("has(name, factory.count(n)) nests children and includes them", async () => {
    const user = await UserFactory.has("posts", PostFactory.count(2)).create();
    expect(user.posts).toHaveLength(2);
    expectTypeOf(user.posts[0]?.title).toEqualTypeOf<string | undefined>();
    // The child definition's inverse relation (author: UserFactory) was
    // stripped: no extra user was created.
    expect(await prisma.user.count()).toBe(1);
  });

  it("supports implicit many-to-many relations", async () => {
    const post = await PostFactory.has("tags", TagFactory.count(3)).create();
    expect(post.tags).toHaveLength(3);
  });

  it("expresses pivot attributes via the join-model factory", async () => {
    const team = await TeamFactory.has("memberships", MembershipFactory.count(2).asRole("owner")).create();
    expect(team.memberships).toHaveLength(2);
    expect(team.memberships.map((m) => m.role)).toEqual(["owner", "owner"]);
    // Each membership auto-created its user; team side was stripped.
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.team.count()).toBe(1);
  });
});

describe("recycle", () => {
  it("reuses the given record for every nested factory of that model", async () => {
    const alice = await UserFactory.create();
    const comment = await CommentFactory.recycle("user", alice).create();
    expect(comment.authorId).toBe(alice.id);
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: comment.postId },
    });
    expect(post.authorId).toBe(alice.id);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("callbacks", () => {
  it("runs afterCreating hooks for the root and nested has() children", async () => {
    const seen: string[] = [];
    const posts: string[] = [];
    const user = await UserFactory.afterCreating((u) => {
      seen.push(u.name);
    })
      .has(
        "posts",
        PostFactory.count(2).afterCreating((p) => {
          posts.push(p.title);
        }),
      )
      .create();
    expect(seen).toEqual([user.name]);
    expect(posts).toHaveLength(2);
  });
});

describe("typing guarantees", () => {
  it("rejects unknown attributes, states, and relation names", () => {
    // @ts-expect-error unknown relation name
    void UserFactory.has("bogus", PostFactory);
    // @ts-expect-error `author` is a to-one relation, not usable with has()
    void PostFactory.has("author", UserFactory);
    // @ts-expect-error unknown attribute in state
    void UserFactory.state({ nope: 1 });
    expect(true).toBe(true);
  });

  it("requires required belongs-to relations in definitions", () => {
    void factorio.define("post", {
      // @ts-expect-error author is required and missing
      definition: () => ({ title: "t" }),
    });
    expect(true).toBe(true);
  });
});
