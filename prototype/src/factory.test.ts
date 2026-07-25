import { beforeEach, describe, expect, it } from "vitest";
import { defineFactory } from "../lib/index.ts";
import { postFactory, tagFactory, teamFactory, userFactory } from "./factories.ts";
import { prisma, reset } from "./support.ts";

beforeEach(reset);

describe("making and creating", () => {
  it("makes attributes without touching the database", async () => {
    const data = userFactory.make();
    expect(data.name).toMatch(/^User \d+$/);
    expect(await prisma.user.count()).toBe(0);
  });

  it("persists a single record", async () => {
    const user = await userFactory.create();
    expect(user.id).toBeGreaterThan(0);
    expect(user.role).toBe("member");
    expect(await prisma.user.count()).toBe(1);
  });

  it("persists many with count()", async () => {
    const users = await userFactory.count(3).create();
    expect(users).toHaveLength(3);
    expect(new Set(users.map((u) => u.email)).size).toBe(3);
  });

  it("applies inline overrides", async () => {
    const user = await userFactory.create({ name: "Abigail Otwell" });
    expect(user.name).toBe("Abigail Otwell");
    expect(user.email).toMatch(/@example\.com$/);
  });
});

describe("states", () => {
  it("applies a declared state", async () => {
    const user = await userFactory.admin().create();
    expect(user.role).toBe("admin");
  });

  it("composes multiple states and keeps count", async () => {
    const users = await userFactory.count(2).admin().unverified().create();
    expect(users).toHaveLength(2);
    expect(users.every((u) => u.role === "admin")).toBe(true);
    expect(users.every((u) => u.verifiedAt === null)).toBe(true);
  });

  it("accepts state arguments", async () => {
    const user = await userFactory.named("Jessica Archer").create();
    expect(user.name).toBe("Jessica Archer");
  });

  it("applies an inline state", async () => {
    const user = await userFactory.state({ role: "editor" }).create();
    expect(user.role).toBe("editor");
  });

  it("gives an inline state access to resolved attributes", async () => {
    const user = await userFactory.state({ name: (attrs) => `<${String(attrs.email)}>` }).create();
    expect(user.name).toBe(`<${user.email}>`);
  });

  it("does not mutate the base factory", async () => {
    await userFactory.admin().create();
    const plain = await userFactory.create();
    expect(plain.role).toBe("member");
  });
});

describe("sequences", () => {
  it("cycles attribute sets across the batch", async () => {
    const users = await userFactory.count(4).sequence({ role: "admin" }, { role: "guest" }).create();
    expect(users.map((u) => u.role)).toEqual(["admin", "guest", "admin", "guest"]);
  });

  it("exposes the index to sequence closures", async () => {
    const users = await userFactory
      .count(3)
      .sequence({ name: (_attrs, ctx) => `Name ${String(ctx.index)}` })
      .create();
    expect(users.map((u) => u.name)).toEqual(["Name 0", "Name 1", "Name 2"]);
  });
});

describe("relations", () => {
  it("creates a belongsTo parent from a factory in the definition", async () => {
    const post = await postFactory.create();
    const author = await prisma.user.findUniqueOrThrow({ where: { id: post.authorId } });
    expect(author.email).toMatch(/@example\.com$/);
    expect(await prisma.user.count()).toBe(1);
  });

  it("creates hasMany children in one nested write", async () => {
    const user = await userFactory.with("posts", postFactory.count(3)).create();
    const posts = await prisma.post.findMany({ where: { authorId: user.id } });
    expect(posts).toHaveLength(3);
    expect(await prisma.user.count()).toBe(1);
  });

  it("attaches a many-to-many relation", async () => {
    const post = await postFactory.with("tags", tagFactory.count(2)).create();
    const withTags = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { tags: true },
    });
    expect(withTags.tags).toHaveLength(2);
  });

  it("connects to an existing record via a raw nested write", async () => {
    const author = await userFactory.create();
    const posts = await postFactory
      .count(2)
      .with("author", { connect: { id: author.id } })
      .create();
    expect(posts.every((p) => p.authorId === author.id)).toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });

  it("lets a child state read the parent's resolved attributes", async () => {
    const user = await userFactory
      .admin()
      .with("posts", postFactory.count(1).state({ title: "by admin" }))
      .create();
    const post = await prisma.post.findFirstOrThrow({ where: { authorId: user.id } });
    expect(post.title).toBe("by admin");
  });

  it("builds an explicit pivot model", async () => {
    const team = await teamFactory.create();
    const memberFactory = defineFactory(prisma, "teamMember", {
      define: () => ({ team: { connect: { id: team.id } }, user: userFactory }),
    });
    await memberFactory.count(2).create();
    const members = await prisma.teamMember.findMany({ where: { teamId: team.id } });
    expect(members).toHaveLength(2);
  });
});

describe("recycle", () => {
  it("reuses one instance for every nested factory of that model", async () => {
    const author = await userFactory.create();
    const posts = await postFactory.count(3).recycle("user", author).create();
    expect(posts.every((p) => p.authorId === author.id)).toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("hooks", () => {
  it("runs afterMaking with the resolved data", () => {
    const seen: string[] = [];
    userFactory.afterMaking((data) => seen.push(String(data.name))).make();
    expect(seen).toHaveLength(1);
  });

  it("runs afterCreating with the persisted row", async () => {
    const ids: number[] = [];
    const user = await userFactory.afterCreating((row) => void ids.push(row.id)).create();
    expect(ids).toEqual([user.id]);
  });

  it("runs afterCreating once per record in a batch", async () => {
    const ids: number[] = [];
    await userFactory
      .count(3)
      .afterCreating((row) => void ids.push(row.id))
      .create();
    expect(ids).toHaveLength(3);
  });
});
