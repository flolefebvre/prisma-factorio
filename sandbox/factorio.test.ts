import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { CreateData, HasRelation, ForRelation } from "./factorio.ts";
import {
  MembershipFactory,
  PostFactory,
  ProfileFactory,
  TagFactory,
  TeamFactory,
  UserFactory,
  prisma,
} from "./factories.ts";

beforeEach(async () => {
  await prisma.teamMembership.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.post.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

describe("defaults and overrides", () => {
  it("creates a record from the definition", async () => {
    const user = await UserFactory.create();
    expect(user.id).toBeTypeOf("number");
    expect(user.role).toBe("USER");
    expect(user.email).toMatch(/^user-\d+@example\.test$/);
    expectTypeOf(user.email).toEqualTypeOf<string>();
    expectTypeOf(user.createdAt).toEqualTypeOf<Date>();
  });

  it("applies overrides passed to create()", async () => {
    const user = await UserFactory.create({ name: "Abigail" });
    expect(user.name).toBe("Abigail");
  });

  it("rejects unknown attributes at the type level", () => {
    // @ts-expect-error - "nope" is not a User field
    void UserFactory.make({ nope: 1 });
  });

  it("gives every record a distinct sequence value", async () => {
    const users = await UserFactory.count(3).create();
    expect(users).toHaveLength(3);
    expect(new Set(users.map((u) => u.email)).size).toBe(3);
    expectTypeOf(users).toBeArray();
  });
});

describe("states", () => {
  it("exposes named states as chainable methods", async () => {
    const user = await UserFactory.admin().create();
    expect(user.role).toBe("ADMIN");
  });

  it("supports parameterized states", async () => {
    const user = await UserFactory.named("Bob").admin().create();
    expect(user.name).toBe("Bob");
    expect(user.role).toBe("ADMIN");
  });

  it("applies inline state objects and closures in order", async () => {
    const user = await UserFactory.state({ name: "First" })
      .state(({ attrs }) => ({ email: `${String(attrs.name).toLowerCase()}@x.test` }))
      .create();
    expect(user.email).toBe("first@x.test");
  });

  it("rotates sequence() values by record index", async () => {
    const users = await UserFactory.count(4).sequence({ role: "A" }, { role: "B" }).create();
    expect(users.map((u) => u.role)).toEqual(["A", "B", "A", "B"]);
  });
});

describe("belongs-to relations", () => {
  it("creates the parent declared in the definition", async () => {
    const post = await PostFactory.create();
    expect(post.authorId).toBeTypeOf("number");
    expect(await prisma.user.count()).toBe(1);
  });

  it("for() with a factory overrides the definition parent", async () => {
    const post = await PostFactory.for("author", UserFactory.admin()).create();
    const author = await prisma.user.findUniqueOrThrow({ where: { id: post.authorId } });
    expect(author.role).toBe("ADMIN");
    expect(await prisma.user.count()).toBe(1);
  });

  it("for() with an existing record connects instead of creating", async () => {
    const existing = await UserFactory.create();
    const posts = await PostFactory.count(2).for("author", existing).create();
    expect(posts.map((p) => p.authorId)).toEqual([existing.id, existing.id]);
    expect(await prisma.user.count()).toBe(1);
  });

  it("recycle() reuses pooled records for definition parents", async () => {
    const pooled = await UserFactory.create();
    const posts = await PostFactory.count(3).recycle("user", pooled).create();
    expect(posts.every((p) => p.authorId === pooled.id)).toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("has relations", () => {
  it("creates children connected to the parent, overriding their definition parent", async () => {
    const user = await UserFactory.has("posts", PostFactory.count(3)).create();
    const posts = await prisma.post.findMany();
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.authorId === user.id)).toBe(true);
    expect(await prisma.user.count()).toBe(1);
  });

  it("supports has-one relations", async () => {
    const user = await UserFactory.has("profile", ProfileFactory).create();
    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(profile.bio).toMatch(/^Bio /);
  });

  it("passes the parent to child state closures", async () => {
    await UserFactory.named("Ada")
      .has(
        "posts",
        PostFactory.state(({ parent }) => ({ title: `${(parent as { name: string }).name}'s post` })),
      )
      .create();
    const post = await prisma.post.findFirstOrThrow();
    expect(post.title).toBe("Ada's post");
  });

  it("connects existing records instead of creating when given records", async () => {
    const tags = await TagFactory.count(2).create();
    const post = await PostFactory.has("tags", tags).create();
    const found = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { tags: true },
    });
    expect(found.tags).toHaveLength(2);
    expect(await prisma.tag.count()).toBe(2);
  });

  it("creates implicit many-to-many children", async () => {
    const post = await PostFactory.has("tags", TagFactory.count(2)).create();
    const found = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { tags: true },
    });
    expect(found.tags).toHaveLength(2);
  });

  it("builds explicit many-to-many through the join-model factory", async () => {
    const user = await UserFactory.has("teams", MembershipFactory.count(2).state({ role: "owner" })).create();
    const memberships = await prisma.teamMembership.findMany();
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.userId === user.id)).toBe(true);
    expect(memberships.every((m) => m.role === "owner")).toBe(true);
    expect(await prisma.team.count()).toBe(2);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("hooks", () => {
  it("runs afterMaking before insert and afterCreating after, with the client", async () => {
    const order: string[] = [];
    const user = await UserFactory.afterMaking((attrs) => {
      order.push("making");
      attrs.name = "Hooked";
    })
      .afterCreating(async (record, { client }) => {
        order.push("creating");
        await client.profile.create({ data: { bio: "from hook", userId: record.id } });
      })
      .create();
    expect(order).toEqual(["making", "creating"]);
    expect(user.name).toBe("Hooked");
    expect(await prisma.profile.count({ where: { userId: user.id } })).toBe(1);
  });

  it("runs afterCreating for children created via has()", async () => {
    const seen: number[] = [];
    await UserFactory.has(
      "posts",
      PostFactory.count(2).afterCreating((post) => {
        seen.push(post.id);
      }),
    ).create();
    expect(seen).toHaveLength(2);
  });
});

describe("make", () => {
  it("compiles to create-input data without touching the database", async () => {
    const data = PostFactory.make();
    expect(data.title).toMatch(/^Post /);
    expect(data.author).toHaveProperty("create");
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.post.count()).toBe(0);
    const post = await prisma.post.create({ data });
    expect(post.id).toBeTypeOf("number");
  });

  it("compiles has() children into nested creates without the inverse relation", async () => {
    const data = UserFactory.has("posts", PostFactory.count(2)).make();
    const posts = data.posts as { create: Record<string, unknown>[] };
    expect(posts.create).toHaveLength(2);
    expect(posts.create.every((p) => !("author" in p))).toBe(true);
    const user = await prisma.user.create({ data });
    expect(await prisma.post.count({ where: { authorId: user.id } })).toBe(2);
  });
});

describe("batching and transactions", () => {
  it("createMany inserts scalar rows and reports the count", async () => {
    const n = await UserFactory.count(3).createMany();
    expect(n).toBe(3);
    expect(await prisma.user.count()).toBe(3);
  });

  it("using() rebinds the whole composition to a transaction client", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await UserFactory.using(tx).has("posts", PostFactory).create();
        expect(await tx.user.count()).toBe(1);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.post.count()).toBe(0);
  });
});

describe("connect strategy findings", () => {
  it("accepts all scalars of a record as a connect filter (extended where-unique)", async () => {
    const user = await UserFactory.create();
    const post = await prisma.post.create({
      data: {
        title: "direct",
        author: {
          connect: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            createdAt: user.createdAt,
          },
        },
      },
    });
    expect(post.authorId).toBe(user.id);
  });

  it("documents that composite-id models reject flat scalar connect filters", async () => {
    const membership = await MembershipFactory.create();
    await expect(
      prisma.team.create({
        data: {
          name: "reuse",
          members: {
            // @ts-expect-error - flat composite fields are not a valid where-unique
            connect: { userId: membership.userId, teamId: membership.teamId },
          },
        },
      }),
    ).rejects.toThrow();
  });
});

describe("type-level relation classification", () => {
  type UserData = CreateData<typeof prisma.user>;
  type PostData = CreateData<typeof prisma.post>;
  type ProfileData = CreateData<typeof prisma.profile>;
  type MembershipData = CreateData<typeof prisma.teamMembership>;

  it("classifies relation keys from the create input", () => {
    expectTypeOf<HasRelation<UserData>>().toEqualTypeOf<"posts" | "teams" | "profile">();
    expectTypeOf<ForRelation<UserData>>().toEqualTypeOf<"profile">();
    expectTypeOf<HasRelation<PostData>>().toEqualTypeOf<"tags" | "author">();
    expectTypeOf<ForRelation<PostData>>().toEqualTypeOf<"author">();
    expectTypeOf<HasRelation<ProfileData>>().toEqualTypeOf<"user">();
    expectTypeOf<ForRelation<ProfileData>>().toEqualTypeOf<"user">();
    expectTypeOf<ForRelation<MembershipData>>().toEqualTypeOf<"user" | "team">();
  });

  it("rejects invalid relation names and state values", () => {
    // @ts-expect-error - scalars are not relations
    void UserFactory.has("email", PostFactory);
    // @ts-expect-error - to-many relations cannot be used with for()
    void PostFactory.for("tags", TagFactory);
    // @ts-expect-error - role must be a string
    void UserFactory.state({ role: 123 });
  });
});
