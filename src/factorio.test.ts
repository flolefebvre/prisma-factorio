import { allLocales } from "@faker-js/faker";
import { afterEach, expect, test, vi } from "vitest";
import type { FactorioOptions } from "./faker.js";
import { initPrismaFactorio, type Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type { TestClient } from "./tests/client.js";
import { disposableClient, factorioHarness, userDefinition, type Harness } from "./tests/factorio.js";

interface CountedBootstrap {
  resolutions: () => number;
  userFactory: Factory<TestClient, "user">;
}

function bootstrapCountingResolutions(prisma: TestClient): CountedBootstrap {
  let resolutions = 0;
  const prismaFactorio = initPrismaFactorio(() => {
    resolutions += 1;
    return prisma;
  });

  return { resolutions: () => resolutions, userFactory: prismaFactorio.define("user", { definition: userDefinition }) };
}

function namesFrom(prismaFactorio: Factorio<TestClient>): Factory<TestClient, "user", { name: string | null }[]> {
  return prismaFactorio
    .define("user", {
      definition: ({ faker, uid }) => ({ email: `${uid}@example.com`, name: faker.person.fullName() }),
    })
    .count(3);
}

async function seededNames(options: FactorioOptions): Promise<(string | null)[]> {
  const { prismaFactorio } = await factorioHarness(options);
  const rows = await namesFrom(prismaFactorio).create();

  return rows.map((row) => row.name);
}

function titledPostsFrom({ prismaFactorio, userFactory }: Harness): Factory<TestClient, "post"> {
  return prismaFactorio.define("post", {
    definition: ({ faker }) => ({ title: faker.lorem.words(3), author: userFactory }),
  });
}

interface Run {
  titles: string[];
  picks: number[];
}

// Every run pools users of its own, so a pick is read as its position in the pool: ids differ from one
// database to the next, and from one run to the next on the same one.
async function drawnRun({ userFactory }: Harness, postFactory: Factory<TestClient, "post">): Promise<Run> {
  const pool = await userFactory.count(3).create();
  const ids = pool.map((user) => user.id);
  const rows = await postFactory.count(6).recycle("user", pool).create();

  return { titles: rows.map((post) => post.title), picks: rows.map((post) => ids.indexOf(post.authorId)) };
}

async function freshRun(options: FactorioOptions): Promise<Run> {
  const harness = await factorioHarness(options);

  return drawnRun(harness, titledPostsFrom(harness));
}

// A definition reaches @faker-js/faker through a deferred import, so a mock registered here still
// lands — but only through a module registry reset, which the whole graph then reloads behind.
async function factorioWithoutFaker(prisma: TestClient): Promise<Factorio<TestClient>> {
  vi.doMock("@faker-js/faker", () => {
    throw new Error("Cannot find package '@faker-js/faker'");
  });
  vi.resetModules();
  const module: typeof import("./factorio.js") = await import("./factorio.js");

  return module.initPrismaFactorio(prisma);
}

afterEach(() => {
  vi.doUnmock("@faker-js/faker");
  vi.resetModules();
});

test("a client instance and a thunk both reach the database", async () => {
  const prisma = await disposableClient();
  const config = { definition: userDefinition };

  await initPrismaFactorio(prisma).define("user", config).create();
  await initPrismaFactorio(() => prisma)
    .define("user", config)
    .create();

  await expect(prisma.user.count()).resolves.toBe(2);
});

test("a thunk is not invoked until the first create()", async () => {
  const prisma = await disposableClient();

  const { resolutions, userFactory } = bootstrapCountingResolutions(prisma);

  expect(resolutions()).toBe(0);
  await userFactory.create();
  expect(resolutions()).toBe(1);
});

test("a thunk is invoked once however many records are created", async () => {
  const prisma = await disposableClient();
  const { resolutions, userFactory } = bootstrapCountingResolutions(prisma);

  await userFactory.count(2).create();
  await userFactory.create();

  expect(resolutions()).toBe(1);
});

test("the same seed replays the same values through a definition", async () => {
  expect(await seededNames({ seed: 7 })).toStrictEqual(await seededNames({ seed: 7 }));
});

test("a different seed produces different values through a definition", async () => {
  expect(await seededNames({ seed: 7 })).not.toStrictEqual(await seededNames({ seed: 8 }));
});

test("a reseed replays, through a factory defined before it, the values and picks of a fresh bootstrap on that seed", async () => {
  const harness = await factorioHarness({ seed: 3 });
  const postFactory = titledPostsFrom(harness);
  await drawnRun(harness, postFactory);

  harness.prismaFactorio.reseed(11);

  expect(await drawnRun(harness, postFactory)).toStrictEqual(await freshRun({ seed: 11 }));
});

test("a reseed before faker first resolves is honoured", async () => {
  const harness = await factorioHarness({ seed: 3 });
  const postFactory = titledPostsFrom(harness);

  harness.prismaFactorio.reseed(11);

  expect(await drawnRun(harness, postFactory)).toStrictEqual(await freshRun({ seed: 11 }));
});

test("a reseed without a seed parts company with the seed the bootstrap held", async () => {
  const harness = await factorioHarness({ seed: 7 });

  harness.prismaFactorio.reseed();

  expect(await drawnRun(harness, titledPostsFrom(harness))).not.toStrictEqual(await freshRun({ seed: 7 }));
});

test("the locale reaches the faker a definition reads", async () => {
  const { prismaFactorio } = await factorioHarness({ locale: "fr", seed: 3 });
  const cityFactory = prismaFactorio.define("user", {
    definition: ({ faker, uid }) => ({ email: `${uid}@example.com`, name: faker.location.city() }),
  });

  const rows = await cityFactory.count(10).create();

  expect(allLocales.fr.location?.city_name).toEqual(expect.arrayContaining(rows.map((row) => row.name)));
});

test("a definition that never reads faker runs with @faker-js/faker absent", async () => {
  const prisma = await disposableClient();
  const prismaFactorio = await factorioWithoutFaker(prisma);

  const user = await prismaFactorio.define("user", { definition: userDefinition }).create();

  expect(user.name).toBe("Ada");
});

// Asserted on the guidance rather than on the package name: the absent package names itself in its
// own import failure, so only the guidance tells the library's error apart from a propagated one.
test("reading faker with @faker-js/faker absent names what to install", async () => {
  const prisma = await disposableClient();
  const prismaFactorio = await factorioWithoutFaker(prisma);
  const personFactory = prismaFactorio.define("user", {
    definition: ({ faker, uid }) => ({ email: `${uid}@e.com`, name: faker.person.fullName() }),
  });

  await expect(personFactory.create()).rejects.toThrow(/Install it \(for example `pnpm add -D @faker-js\/faker`\)/);
});
