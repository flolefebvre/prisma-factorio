import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { freshClient } from "./db.ts";
import { buildFactories, type Factories } from "./factories.ts";

let prisma: PrismaClient;
let f: Factories;

beforeAll(async () => {
  prisma = await freshClient("usage");
  f = buildFactories(prisma);
});

describe("creating records", () => {
  it("persists one record from the definition", async () => {
    const user = await f.user.create();
    expect(user.id).toBeGreaterThan(0);
    expect(user.email).toMatch(/@example\.com$/);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  });

  it("produces an array under count()", async () => {
    const users = await f.user.count(3).create();
    expect(users).toHaveLength(3);
    expect(new Set(users.map((u) => u.email)).size).toBe(3);
  });

  it("applies named states as chainable methods", async () => {
    const user = await f.user.admin().unverified().create();
    expect(user.role).toBe("admin");
    expect(user.emailVerifiedAt).toBeNull();
  });

  it("applies inline states and call-site overrides", async () => {
    const user = await f.user.state({ role: "editor" }).create({ name: "Ada" });
    expect(user.role).toBe("editor");
    expect(user.name).toBe("Ada");
  });

  it("cycles a sequence across the batch", async () => {
    const users = await f.user.count(4).sequence({ role: "a" }, { role: "b" }).create();
    expect(users.map((u) => u.role)).toEqual(["a", "b", "a", "b"]);
  });

  it("cycles a field declared with cycle()", async () => {
    const taggings = await f.tagging.count(4).create();
    expect(taggings.map((t) => t.public)).toEqual([true, false, true, false]);
  });

  it("resolves lazy fields against sibling attributes", async () => {
    const post = await f.post.create({ title: "Hello" });
    expect(post.content).toBe("Body of Hello");
  });
});

describe("relations", () => {
  it("creates children through has() and returns them", async () => {
    const user = await f.user.has("posts", 3).create();
    expect(user.posts).toHaveLength(3);
    expect(user.posts.every((p) => p.authorId === user.id)).toBe(true);
  });

  it("accepts a configured child factory in has()", async () => {
    const user = await f.user.has("posts", f.post.count(2).published()).create();
    expect(user.posts).toHaveLength(2);
    expect(user.posts.every((p) => p.published)).toBe(true);
  });

  it("shares one parent across the batch with for()", async () => {
    const before = await prisma.user.count();
    const posts = await f.post.count(3).for("author", f.user).create();
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.authorId)).size).toBe(1);
    expect(await prisma.user.count()).toBe(before + 1);
  });

  it("accepts an existing record in for()", async () => {
    const author = await f.user.create();
    const posts = await f.post.count(2).for("author", author).create();
    expect(posts.every((p) => p.authorId === author.id)).toBe(true);
    expect(posts[0]?.author.name).toBe(author.name);
  });

  it("creates a fresh parent per record when the definition holds a factory", async () => {
    const posts = await f.post.count(3).create();
    expect(new Set(posts.map((p) => p.authorId)).size).toBe(3);
  });

  it("nests has() declarations to any depth", async () => {
    const user = await f.user.has("posts", f.post.count(2).has("taggings", 1)).create();
    expect(user.posts).toHaveLength(2);
  });
});

describe("many to many", () => {
  it("creates an implicit m2m relation through has()", async () => {
    const post = await f.post.has("tags", 2).create();
    expect(post.tags).toHaveLength(2);
  });

  it("connects existing records with attach()", async () => {
    const tags = await f.tag.count(2).create();
    const post = await f.post.attach("tags", ...tags).create();
    expect(post.tags.map((t) => t.id).sort()).toEqual(tags.map((t) => t.id).sort());
  });

  it("carries pivot columns through an explicit join model", async () => {
    const post = await f.post.has("taggings", f.tagging.count(2).state({ public: false })).create();
    expect(post.taggings).toHaveLength(2);
    expect(post.taggings.every((t) => !t.public)).toBe(true);
  });
});

describe("atomicity", () => {
  it("rolls back the whole batch when one record fails", async () => {
    const before = await prisma.user.count();
    const clash = await f.user.create();
    await expect(f.user.count(3).sequence({}, { email: clash.email }, {}).create()).rejects.toThrow();
    expect(await prisma.user.count()).toBe(before + 1);
  });
});

describe("recycling", () => {
  it("reuses one record for every relation of its model", async () => {
    const airline = await f.airline.create();
    const ticket = await f.ticket.recycle("airline", airline).create();
    const flight = await prisma.flight.findUniqueOrThrow({ where: { id: ticket.flightId } });
    expect(ticket.airlineId).toBe(airline.id);
    expect(flight.airlineId).toBe(airline.id);
  });
});

describe("hooks", () => {
  it("runs afterCreate on the parent and on has() children", async () => {
    const seen: string[] = [];
    const user = await f.user
      .afterCreate((u) => {
        seen.push(`user:${String(u.id)}`);
      })
      .has(
        "posts",
        f.post.count(2).afterCreate((p) => {
          seen.push(`post:${String(p.id)}`);
        }),
      )
      .create();
    expect(seen.filter((s) => s.startsWith("post:"))).toHaveLength(2);
    expect(seen).toContain(`user:${String(user.id)}`);
  });
});

describe("build()", () => {
  it("resolves attributes without writing", async () => {
    const before = await prisma.user.count();
    const data = await f.user.build({ name: "Grace" });
    expect(data).toMatchObject({ name: "Grace" });
    expect(await prisma.user.count()).toBe(before);
  });
});

describe("transactions", () => {
  it("rebinds every factory in the scope to a transaction client", async () => {
    const before = await prisma.user.count();
    await expect(
      prisma.$transaction(async (tx) =>
        f.withClient(tx as unknown as PrismaClient, async () => {
          await f.user.count(2).create();
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");
    expect(await prisma.user.count()).toBe(before);
  });
});
