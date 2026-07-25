import { afterEach, expect, test } from "vitest";
import { createTestClient, disposeTestClient, type TestClient } from "./client.js";

const open: TestClient[] = [];

async function testClient(): Promise<TestClient> {
  const client = await createTestClient();
  open.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(disposeTestClient));
});

test("a created row round-trips through the scratch schema", async () => {
  const prisma = await testClient();

  const author = await prisma.user.create({ data: { email: "ada@example.com", name: "Ada" } });
  await prisma.post.create({ data: { title: "Hello", author: { connect: { id: author.id } } } });

  const read = await prisma.user.findUniqueOrThrow({
    where: { email: "ada@example.com" },
    include: { posts: true },
  });

  expect(author.id).toBeGreaterThan(0);
  expect(read).toMatchObject({ id: author.id, name: "Ada" });
  expect(read.posts).toHaveLength(1);
  expect(read.posts[0]).toMatchObject({ title: "Hello", authorId: author.id });
});

test("the scratch schema's unique constraint on User.email is enforced", async () => {
  const prisma = await testClient();

  await prisma.user.create({ data: { email: "ada@example.com" } });

  await expect(prisma.user.create({ data: { email: "ada@example.com" } })).rejects.toThrow(/Unique constraint failed/);
});

test("two separately created test clients do not share data", async () => {
  const first = await testClient();
  const second = await testClient();

  await first.user.create({ data: { email: "ada@example.com" } });

  await expect(second.user.findMany()).resolves.toStrictEqual([]);
  await expect(first.user.findMany()).resolves.toHaveLength(1);
});
