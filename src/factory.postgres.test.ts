import { randomUUID } from "node:crypto";
import { expect, onTestFinished, test } from "vitest";
import { initPrismaFactorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type { Row } from "./prisma.js";
import {
  createPostgresTestClient,
  disposePostgresTestClient,
  type PostgresTestClient,
} from "./tests/postgres/client.js";
import { Role } from "./tests/postgres/generated/client.js";

interface Lane {
  prisma: PostgresTestClient;
  userFactory: Factory<PostgresTestClient, "user">;
  postFactory: Factory<PostgresTestClient, "post">;
  teamFactory: Factory<PostgresTestClient, "team">;
  membershipFactory: Factory<PostgresTestClient, "membership">;
  badgeFactory: Factory<PostgresTestClient, "badge">;
}

type User = Row<PostgresTestClient, "user">;

// A database of its own per test, with one factory per model of the Postgres scratch schema. The user
// definition fills the native enum and the `@db.Uuid` column. Post, membership and badge carry a
// relation default, so a badge brings a membership, which brings a user and a team.
async function lane(): Promise<Lane> {
  const prisma = await createPostgresTestClient();
  onTestFinished(() => disposePostgresTestClient(prisma));
  const prismaFactorio = initPrismaFactorio(prisma);
  const teamFactory = prismaFactorio.define("team", { definition: ({ uid }) => ({ slug: uid }) });
  const userFactory = prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@example.com`, token: randomUUID(), role: Role.MEMBER }),
  });
  const postFactory = prismaFactorio.define("post", { definition: ({ uid }) => ({ author: userFactory, title: uid }) });
  const membershipFactory = prismaFactorio.define("membership", {
    definition: () => ({ team: teamFactory, user: userFactory }),
  });
  const badgeFactory = prismaFactorio.define("badge", {
    definition: ({ uid }) => ({ membership: membershipFactory, note: uid }),
  });

  return { prisma, teamFactory, userFactory, postFactory, membershipFactory, badgeFactory };
}

// Every route a row reaches `connect` through: `for`, a relation attribute and a recycle pool.
async function authorIdsThroughEveryRoute(postFactory: Lane["postFactory"], ada: User): Promise<number[]> {
  const followed = await postFactory.for(ada, "author").create();
  const handed = await postFactory.create({ author: ada });
  const drawn = await postFactory.recycle("user", ada).create();

  return [followed.authorId, handed.authorId, drawn.authorId];
}

const STALE = { cause: { code: "P2025" } };

test("a relation default creates the parent, the definition filling a native enum and a @db.Uuid column", async () => {
  const { prisma, postFactory } = await lane();

  const post = await postFactory.create();
  const author = await prisma.user.findUniqueOrThrow({ where: { id: post.authorId } });

  expect(author.role).toBe(Role.MEMBER);
  expect(author.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("count(2).for(factory) creates one parent the whole batch connects to", async () => {
  const { prisma, postFactory, userFactory } = await lane();

  const posts = await postFactory.count(2).for(userFactory).create();

  await expect(prisma.user.count()).resolves.toBe(1);
  expect(posts.map((post) => post.authorId)).toStrictEqual([posts[0]?.authorId, posts[0]?.authorId]);
});

test("for(factory) creates the parent and for(row) connects to one that already exists", async () => {
  const { prisma, postFactory, userFactory } = await lane();
  const ada = await userFactory.create();

  const created = await postFactory.for(userFactory, "author").create();
  const connected = await postFactory.for(ada, "author").create();

  await expect(prisma.user.count()).resolves.toBe(2);
  expect(connected.authorId).toBe(ada.id);
  expect(created.authorId).not.toBe(ada.id);
});

test("has(factory) creates the children for the parent and has(rows) connects existing ones", async () => {
  const { prisma, postFactory, userFactory } = await lane();
  const orphaned = await postFactory.create();

  const ada = await userFactory.has(postFactory.count(2), "posts").has([orphaned], "posts").create();

  await expect(prisma.post.count({ where: { authorId: ada.id } })).resolves.toBe(3);
});

test("recycle() fills every slot of the pooled model, creating no record of it", async () => {
  const { prisma, postFactory, userFactory } = await lane();
  const ada = await userFactory.create();

  const posts = await postFactory.recycle("user", ada).count(3).create();

  expect(posts.map((post) => post.authorId)).toStrictEqual([ada.id, ada.id, ada.id]);
  await expect(prisma.user.count()).resolves.toBe(1);
});

test("a relation default creating a compound-keyed row writes both columns of its key", async () => {
  const { prisma, badgeFactory } = await lane();

  const badge = await badgeFactory.create();

  await expect(prisma.membership.findMany()).resolves.toStrictEqual([{ userId: badge.userId, teamId: badge.teamId }]);
});

test("an existing compound-keyed row connects on its key, handed over or drawn from a pool", async () => {
  const { prisma, badgeFactory, membershipFactory } = await lane();
  const membership = await membershipFactory.create();

  const handed = await badgeFactory.create({ membership });
  const drawn = await badgeFactory.recycle("membership", membership).create();

  expect([handed, drawn].map(({ userId, teamId }) => ({ userId, teamId }))).toStrictEqual([membership, membership]);
  await expect(prisma.membership.count()).resolves.toBe(1);
});

test("has() children of a compound-keyed parent reach back on its key", async () => {
  const { prisma, badgeFactory, membershipFactory } = await lane();

  const membership = await membershipFactory.has(badgeFactory.count(2), "badges").create();

  await expect(prisma.badge.count({ where: membership })).resolves.toBe(2);
});

// A scalar list is typed as a list filter in `WhereUniqueInput`, so it stays out of the connect
// where-clause (#65).
test("a row whose scalar list holds values connects, through for, an attribute or a pool", async () => {
  const { postFactory, userFactory } = await lane();
  const ada = await userFactory.create({ tags: ["math", "engines"] });

  await expect(authorIdsThroughEveryRoute(postFactory, ada)).resolves.toStrictEqual([ada.id, ada.id, ada.id]);
});

test("a row whose Json column holds a value connects, through for, an attribute or a pool", async () => {
  const { postFactory, userFactory } = await lane();
  const ada = await userFactory.create({ meta: { born: 1815, notes: ["G"] } });

  await expect(authorIdsThroughEveryRoute(postFactory, ada)).resolves.toStrictEqual([ada.id, ada.id, ada.id]);
});

test("a row holding a native enum and a @db.Uuid value connects, through for, an attribute or a pool", async () => {
  const { postFactory, userFactory } = await lane();
  const ada = await userFactory.create({ role: Role.OWNER });

  await expect(authorIdsThroughEveryRoute(postFactory, ada)).resolves.toStrictEqual([ada.id, ada.id, ada.id]);
});

// The native enum and the `@db.Uuid` column stay in the where-clause, matched as the types they are:
// a row read before either changed reaches no record.
test("a row whose enum or @db.Uuid value has since changed fails to connect", async () => {
  const { prisma, postFactory, userFactory } = await lane();
  const ada = await userFactory.create();
  const grace = await userFactory.create();

  await prisma.user.update({ where: { id: ada.id }, data: { role: Role.OWNER } });
  await prisma.user.update({ where: { id: grace.id }, data: { token: randomUUID() } });

  await expect(postFactory.for(ada, "author").create()).rejects.toMatchObject(STALE);
  await expect(postFactory.for(grace, "author").create()).rejects.toMatchObject(STALE);
});

// Leaving the list and the Json column out narrows the match by nothing else.
test("a stale row holding a scalar list and a Json value still fails to connect", async () => {
  const { prisma, postFactory, userFactory } = await lane();
  const ada = await userFactory.create({ tags: ["math"], meta: { born: 1815 } });

  await prisma.user.update({ where: { id: ada.id }, data: { email: "grace@example.com" } });

  await expect(postFactory.for(ada, "author").create()).rejects.toMatchObject(STALE);
});
