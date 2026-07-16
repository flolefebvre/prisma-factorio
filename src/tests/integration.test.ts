import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { initPrismaFactorio } from "../factories/index.ts";
import type { PrismaClient } from "./generated/client/client.ts";
import type { UserCreateInput } from "./generated/client/models.ts";
import { Role } from "./generated/client/enums.ts";
import {
  CategoryFactoryBase,
  PostFactoryBase,
  PostTagFactoryBase,
  registerFactories,
  TagFactoryBase,
  UserFactoryBase,
} from "./generated/prisma-factorio/index.ts";
import { createIntegrationClient } from "./integration-db.ts";

class UserFactory extends UserFactoryBase {
  definition() {
    return { email: `user-${randomUUID()}@example.com`, role: Role.MEMBER };
  }
}

class PostFactory extends PostFactoryBase {
  definition() {
    return {
      title: "Nested create",
      wordCount: 500,
      views: 1000n,
      rating: 4.2,
      price: "9.99",
      isPublished: true,
      metadata: { tags: ["intro"] },
      thumbnail: new Uint8Array([1, 2, 3]),
      reviewedAt: new Date("2026-01-01T00:00:00Z"),
      author: UserFactory.new(),
    };
  }
}

class TagFactory extends TagFactoryBase {
  definition() {
    return { label: `tag-${randomUUID()}` };
  }
}

// The explicit join model: both required belongsTo relations are factory-as-
// values, so a PostTag can be created from any side; `active` / `note` are
// ordinary pivot columns.
class PostTagFactory extends PostTagFactoryBase {
  definition() {
    return { post: PostFactory.new(), tag: TagFactory.new() };
  }
}

class CategoryFactory extends CategoryFactoryBase {
  definition() {
    return { name: `category-${randomUUID()}` };
  }
}

// The magic short forms (`hasPosts(3)`, `hasTags(2)`, `hasPostTags(3)`,
// `hasChildren(2)`) resolve their default child factory here.
registerFactories({
  User: UserFactory,
  Post: PostFactory,
  Tag: TagFactory,
  PostTag: PostTagFactory,
  Category: CategoryFactory,
});

const openClients: PrismaClient[] = [];

async function openClient(): Promise<PrismaClient> {
  const client = await createIntegrationClient();
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.$disconnect()));
});

test("create() with a registered client instance persists a row a fresh query reads back", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const created = await UserFactory.new().create();

  const found = await prisma.user.findUnique({ where: { id: created.id } });
  expect(found).not.toBeNull();
  expect(found?.email).toBe(created.email);
  expect(found?.role).toBe(Role.MEMBER);
});

test("count() with sequence() persists n rows, cycling the sequenced field and re-evaluating the definition per row", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const created = await UserFactory.new().count(3).sequence({ role: Role.ADMIN }, { role: Role.MEMBER }).create();

  // create() returns the rows in creation order, so the cycle reads off directly.
  expect(created.map((row) => row.role)).toEqual([Role.ADMIN, Role.MEMBER, Role.ADMIN]);
  // Distinct emails prove definition() re-ran for each instance.
  expect(new Set(created.map((row) => row.email)).size).toBe(3);

  // The rows really reached the database. Matched by id set, not position: the
  // id is a random uuid, so a re-query cannot recover creation order.
  const persisted = await prisma.user.findMany();
  expect(persisted).toHaveLength(3);
  expect(new Set(persisted.map((row) => row.id))).toEqual(new Set(created.map((row) => row.id)));
});

test("create() persists a factory-as-value relation as one nested create, linking parent and child in the DB", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const post = await PostFactory.new().create();

  // The child was born from the nested create, not connected: exactly one user
  // exists and the post's foreign key points at it.
  const users = await prisma.user.findMany();
  expect(users).toHaveLength(1);

  const persisted = await prisma.post.findUnique({ where: { id: post.id }, include: { author: true } });
  expect(persisted).not.toBeNull();
  expect(persisted?.authorId).toBe(users[0]?.id);
  expect(persisted?.author.email).toBe(users[0]?.email);
});

test("a caller-supplied relation connects an existing row instead of evaluating the nested factory", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });
  const existing = await UserFactory.new().create();

  const post = await PostFactory.new().create({ author: { connect: { id: existing.id } } });

  // No second user was born: the supplied connect short-circuited the factory.
  expect(await prisma.user.findMany()).toHaveLength(1);
  const persisted = await prisma.post.findUnique({ where: { id: post.id } });
  expect(persisted?.authorId).toBe(existing.id);
});

test("a getter registration is resolved on every create(), so swapping the client redirects persistence", async () => {
  const first = await openClient();
  const second = await openClient();
  let current = first;
  initPrismaFactorio({ prisma: () => current });

  const rowInFirst = await UserFactory.new().create();
  current = second;
  const rowInSecond = await UserFactory.new().create();

  expect(await first.user.findUnique({ where: { id: rowInFirst.id } })).not.toBeNull();
  expect(await second.user.findUnique({ where: { id: rowInFirst.id } })).toBeNull();
  expect(await second.user.findUnique({ where: { id: rowInSecond.id } })).not.toBeNull();
  expect(await first.user.findUnique({ where: { id: rowInSecond.id } })).toBeNull();
});

test("hasPosts(n) persists the whole tree in one atomic nested create, with no duplicate parent", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const user = await UserFactory.new().hasPosts(3).create();

  // The return type carries the created posts, and exactly one user exists —
  // each child Post's own author factory-as-value was short-circuited.
  expect(user.posts).toHaveLength(3);
  expect(await prisma.user.findMany()).toHaveLength(1);
  const posts = await prisma.post.findMany({ where: { authorId: user.id } });
  expect(posts).toHaveLength(3);
});

test("forAuthor(existingRow) connects the row instead of creating a second user", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });
  const author = await UserFactory.new().create();

  const post = await PostFactory.new().forAuthor(author).create();

  expect(post.author.id).toBe(author.id);
  expect(await prisma.user.findMany()).toHaveLength(1);
});

test("forAuthor(factory) nests a create for the configured author", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const post = await PostFactory.new()
    .forAuthor(UserFactory.new().state({ email: "nested@example.com" }))
    .create();

  expect(post.author.email).toBe("nested@example.com");
  expect(await prisma.user.findMany()).toHaveLength(1);
});

test("a hasPosts child state closure reads the parent's evaluated CreateInput", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const user = await UserFactory.new()
    .state({ email: "parent@example.com" })
    .hasPosts(
      PostFactory.new()
        .count(2)
        .state((_attrs, parent: UserCreateInput) => ({ title: `by ${parent.email}` })),
    )
    .create();

  expect(user.posts.map((post) => post.title)).toEqual(["by parent@example.com", "by parent@example.com"]);
});

test("implicit many-to-many: hasTags(n) creates and links tags through the join table", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const post = await PostFactory.new().hasTags(2).create();

  expect(post.tags).toHaveLength(2);
  expect(await prisma.tag.findMany()).toHaveLength(2);
  const persisted = await prisma.post.findUnique({ where: { id: post.id }, include: { tags: true } });
  expect(persisted?.tags).toHaveLength(2);
});

test("explicit join, pattern 1: fresh children through the join with a uniform pivot value", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const post = await PostFactory.new().hasPostTags(3, { active: false }).create();

  expect(post.postTags).toHaveLength(3);
  expect(await prisma.postTag.findMany()).toHaveLength(3);
  // Each join row created a fresh tag; the single post was not duplicated.
  expect(await prisma.tag.findMany()).toHaveLength(3);
  expect(await prisma.post.findMany()).toHaveLength(1);
  expect((await prisma.postTag.findMany()).every((row) => !row.active)).toBe(true);
});

test("explicit join, pattern 2: per-row pivot values through a sequence", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  await PostFactory.new()
    .hasPostTags(PostTagFactory.new().count(2).sequence({ note: "first" }, { note: "second" }))
    .create();

  // The nested create persists both sequenced pivot values; the database does
  // not guarantee insertion order, so match the set rather than the sequence
  // (the per-index cycling itself is proven deterministically in the unit tests).
  const notes = (await prisma.postTag.findMany()).map((row) => row.note);
  expect(new Set(notes)).toEqual(new Set(["first", "second"]));
});

test("explicit join, pattern 3: attaching existing rows through the join, never duplicating them", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });
  const tags = await TagFactory.new().count(2).create();

  const post = await PostFactory.new()
    .hasPostTags(tags.map((tag) => PostTagFactory.new().forTag(tag)))
    .create();

  expect(post.postTags).toHaveLength(2);
  // The two existing tags were connected, not re-created.
  expect(await prisma.tag.findMany()).toHaveLength(2);
  const joinRows = await prisma.postTag.findMany({ orderBy: { id: "asc" } });
  expect(joinRows.map((row) => row.tagId).sort()).toEqual(tags.map((tag) => tag.id).sort());
});

test("explicit join, pattern 4: creating from the join side builds both belongsTo sides", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const postTag = await PostTagFactory.new().create();

  expect(await prisma.postTag.findMany()).toHaveLength(1);
  expect(await prisma.post.findMany()).toHaveLength(1);
  expect(await prisma.tag.findMany()).toHaveLength(1);
  const persisted = await prisma.postTag.findUnique({ where: { id: postTag.id } });
  expect(persisted).not.toBeNull();
});

test("a self-relation nests its own class: hasChildren and forParent build a real tree", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const parent = await CategoryFactory.new().hasChildren(2).create();
  const child = await CategoryFactory.new()
    .forParent(CategoryFactory.new().state({ name: "ancestor" }))
    .create();

  // hasChildren: one parent with two children linked back to it.
  expect(parent.children).toHaveLength(2);
  const linked = await prisma.category.findMany({ where: { parentId: parent.id } });
  expect(linked).toHaveLength(2);
  // forParent: the child points at the freshly created ancestor (the typed
  // return makes `parent` non-nullable, since the chain built it).
  expect(child.parent.name).toBe("ancestor");
  const ancestor = await prisma.category.findUnique({ where: { id: child.parentId ?? -1 } });
  expect(ancestor?.name).toBe("ancestor");
});
