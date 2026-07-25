import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { createTestClient, disposeTestClient, statementsOf, type TestClient } from "./client.js";
import { Prisma } from "./generated/client.js";

type GeneratedModule = typeof import("./generated/client.js");
type HarnessModule = typeof import("./client.js");

interface HarnessMocks {
  fileSystem?: Record<string, unknown>;
  disconnects?: MockInstance[];
}

const open: TestClient[] = [];

async function testClient(): Promise<TestClient> {
  const client = await createTestClient();
  open.push(client);
  return client;
}

function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected the promise to be rejected");
    },
    (error: unknown) => error,
  );
}

function missingFile(): Promise<never> {
  return Promise.reject(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));
}

// A stub answers for the one path it is named after; every other path reaches the real `stat`.
function statting(name: string, outcome: () => Promise<unknown>): (path: URL) => Promise<unknown> {
  return (path) => (path.href.endsWith(name) ? outcome() : stat(path));
}

async function harnessFailure(stub: (path: URL) => Promise<unknown>): Promise<string> {
  const harness = await harnessWith({ fileSystem: { stat: stub } });
  return String(await rejectionOf(harness.createTestClient()));
}

// The harness caches the DDL per module instance, so every test that observes the load has to run
// against a module registry reset before its mocks are registered.
async function harnessWith({ fileSystem, disconnects }: HarnessMocks): Promise<HarnessModule> {
  vi.resetModules();

  if (fileSystem) {
    vi.doMock("node:fs/promises", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("node:fs/promises")),
      ...fileSystem,
    }));
  }

  if (disconnects) {
    vi.doMock("./generated/client.js", async () => {
      const actual = await vi.importActual<GeneratedModule>("./generated/client.js");

      return {
        ...actual,
        PrismaClient: function watched(...args: ConstructorParameters<typeof actual.PrismaClient>): TestClient {
          const client = new actual.PrismaClient(...args);
          disconnects.push(vi.spyOn(client, "$disconnect"));
          return client;
        },
      };
    });
  }

  return import("./client.js");
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(disposeTestClient));
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("./generated/client.js");
  vi.resetModules();
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

  const error = await rejectionOf(prisma.user.create({ data: { email: "ada@example.com" } }));

  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(error).toHaveProperty("code", "P2002");
});

test("the scratch schema's foreign key from Post to User is enforced", async () => {
  const prisma = await testClient();

  const error = await rejectionOf(prisma.post.create({ data: { title: "Orphan", authorId: 404 } }));

  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(error).toHaveProperty("code", "P2003");
});

describe("statementsOf", () => {
  test("returns one statement per terminating semicolon", () => {
    expect(statementsOf('CREATE TABLE "a" ("x" INTEGER);\nCREATE TABLE "b" ("y" INTEGER);\n')).toStrictEqual([
      'CREATE TABLE "a" ("x" INTEGER)',
      'CREATE TABLE "b" ("y" INTEGER)',
    ]);
  });

  test("returns a trailing statement left unterminated", () => {
    expect(statementsOf("SELECT 1;\nSELECT 2")).toStrictEqual(["SELECT 1", "SELECT 2"]);
  });

  test("drops blank fragments", () => {
    expect(statementsOf("\n;\nSELECT 1;;\n\n")).toStrictEqual(["SELECT 1"]);
  });

  test("drops a comment-only fragment", () => {
    expect(statementsOf("SELECT 1;\n-- nothing left to run\n")).toStrictEqual(["SELECT 1"]);
  });

  test("keeps a line comment attached to the statement it introduces", () => {
    expect(statementsOf('-- CreateTable\nCREATE TABLE "a" ("x" INTEGER);')).toStrictEqual([
      '-- CreateTable\nCREATE TABLE "a" ("x" INTEGER)',
    ]);
  });

  test("does not end a statement on a semicolon inside a single-quoted literal", () => {
    expect(statementsOf(`ALTER TABLE "a" ADD "bio" TEXT NOT NULL DEFAULT 'hello; world';\nSELECT 1;`)).toStrictEqual([
      `ALTER TABLE "a" ADD "bio" TEXT NOT NULL DEFAULT 'hello; world'`,
      "SELECT 1",
    ]);
  });

  test("reads a doubled quote as an escape rather than the end of a literal", () => {
    expect(statementsOf(`INSERT INTO "a" VALUES ('it''s; fine');\nSELECT 1;`)).toStrictEqual([
      `INSERT INTO "a" VALUES ('it''s; fine')`,
      "SELECT 1",
    ]);
  });

  test("does not end a statement on a semicolon inside a line comment", () => {
    expect(statementsOf("-- one; two\nSELECT 1;")).toStrictEqual(["-- one; two\nSELECT 1"]);
  });
});

test("two separately created test clients do not share data", async () => {
  const first = await testClient();
  const second = await testClient();

  await first.user.create({ data: { email: "ada@example.com" } });

  await expect(second.user.findMany()).resolves.toStrictEqual([]);
  await expect(first.user.findMany()).resolves.toHaveLength(1);
});

test("a client whose schema fails to apply is disposed before the failure surfaces", async () => {
  const disconnects: MockInstance[] = [];
  const harness = await harnessWith({
    fileSystem: { readFile: () => Promise.resolve("NOT A STATEMENT;") },
    disconnects,
  });

  const error = await rejectionOf(harness.createTestClient());

  expect(error).toBeInstanceOf(Error);
  expect(disconnects).toHaveLength(1);
  expect(disconnects[0]).toHaveBeenCalledTimes(1);
});

test("a DDL older than the schema it was emitted from names the command that refreshes it", async () => {
  const ahead = statting("schema.prisma", () => Promise.resolve({ mtimeMs: Number.MAX_SAFE_INTEGER }));

  expect(await harnessFailure(ahead)).toContain("Run `pnpm generate`");
});

test("a DDL that was never generated names the command that emits it", async () => {
  expect(await harnessFailure(statting("schema.sql", missingFile))).toContain("Run `pnpm generate`");
});

test("a scratch schema that cannot be found names the command that rebuilds the harness", async () => {
  expect(await harnessFailure(statting("schema.prisma", missingFile))).toContain("Run `pnpm generate`");
});

test("the DDL is read once per process rather than once per client", async () => {
  let reads = 0;
  const harness = await harnessWith({
    fileSystem: {
      readFile: (path: URL) => {
        reads += 1;
        return readFile(path, "utf8");
      },
    },
  });

  const clients = [await harness.createTestClient(), await harness.createTestClient()];
  await Promise.all(clients.map((client) => harness.disposeTestClient(client)));

  expect(reads).toBe(1);
});
