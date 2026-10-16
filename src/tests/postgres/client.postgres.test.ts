import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createPostgresTestClient, disposePostgresTestClient, type PostgresTestClient } from "./client.js";
import { Prisma } from "./generated/client.js";

const open: PostgresTestClient[] = [];

async function testClient(): Promise<PostgresTestClient> {
  const client = await createPostgresTestClient();
  open.push(client);
  return client;
}

async function databaseOf(client: PostgresTestClient): Promise<string> {
  const [row] = await client.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  return row?.name ?? "";
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(disposePostgresTestClient));
});

test("a created row round-trips through the Postgres scratch schema, every Postgres-only column included", async () => {
  const prisma = await testClient();
  const token = randomUUID();

  const author = await prisma.user.create({
    data: { email: "ada@example.com", token, role: "OWNER", tags: ["math", "engines"], meta: { born: 1815 } },
  });
  await prisma.post.create({ data: { title: "Notes", author: { connect: { id: author.id } } } });

  const read = await prisma.user.findUniqueOrThrow({ where: { email: "ada@example.com" }, include: { posts: true } });

  expect(read).toMatchObject({ token, role: "OWNER", tags: ["math", "engines"], meta: { born: 1815 } });
  expect(read.posts).toHaveLength(1);
});

test("the Postgres scratch schema's foreign key from Post to User is enforced", async () => {
  const prisma = await testClient();

  const error = await prisma.post
    .create({ data: { title: "Orphan", authorId: 404 } })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(error).toHaveProperty("code", "P2003");
});

test("two separately created Postgres test clients sit on two databases and do not share data", async () => {
  const first = await testClient();
  const second = await testClient();

  await first.team.create({ data: { slug: "analysts" } });

  expect(await databaseOf(first)).not.toBe(await databaseOf(second));
  await expect(second.team.findMany()).resolves.toStrictEqual([]);
  await expect(first.team.findMany()).resolves.toHaveLength(1);
});

test("disposing a Postgres test client drops its database", async () => {
  const witness = await testClient();
  const client = await createPostgresTestClient();
  const database = await databaseOf(client);

  await disposePostgresTestClient(client);

  await expect(witness.$queryRaw`SELECT datname FROM pg_database WHERE datname = ${database}`).resolves.toStrictEqual(
    [],
  );
});
