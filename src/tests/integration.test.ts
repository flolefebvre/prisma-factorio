import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { initPrismaFactorio } from "../factories/index.ts";
import type { PrismaClient } from "./generated/client/client.ts";
import { Role } from "./generated/client/enums.ts";
import { PostFactoryBase, UserFactoryBase } from "./generated/prisma-factorio/index.ts";
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
