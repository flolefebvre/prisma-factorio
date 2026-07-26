import { allLocales } from "@faker-js/faker";
import { afterEach, expect, test, vi } from "vitest";
import type { FactorioOptions } from "./faker.js";
import { initPrismaFactorio, type Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type { TestClient } from "./tests/client.js";
import { disposableClient, factorioHarness, userDefinition } from "./tests/factorio.js";

interface CountedBootstrap {
  resolutions: () => number;
  users: Factory<TestClient, "user">;
}

function bootstrapCountingResolutions(prisma: TestClient): CountedBootstrap {
  let resolutions = 0;
  const f = initPrismaFactorio(() => {
    resolutions += 1;
    return prisma;
  });

  return { resolutions: () => resolutions, users: f.define("user", { definition: userDefinition }) };
}

function namesFrom(f: Factorio<TestClient>): Factory<TestClient, "user", { name: string | null }[]> {
  return f
    .define("user", {
      definition: ({ faker, uid }) => ({ email: `${uid}@example.com`, name: faker.person.fullName() }),
    })
    .count(3);
}

async function seededNames(options: FactorioOptions): Promise<(string | null)[]> {
  const { f } = await factorioHarness(options);
  const rows = await namesFrom(f).create();

  return rows.map((row) => row.name);
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

  const { resolutions, users } = bootstrapCountingResolutions(prisma);

  expect(resolutions()).toBe(0);
  await users.create();
  expect(resolutions()).toBe(1);
});

test("a thunk is invoked once however many records are created", async () => {
  const prisma = await disposableClient();
  const { resolutions, users } = bootstrapCountingResolutions(prisma);

  await users.count(2).create();
  await users.create();

  expect(resolutions()).toBe(1);
});

test("the same seed replays the same values through a definition", async () => {
  expect(await seededNames({ seed: 7 })).toStrictEqual(await seededNames({ seed: 7 }));
});

test("a different seed produces different values through a definition", async () => {
  expect(await seededNames({ seed: 7 })).not.toStrictEqual(await seededNames({ seed: 8 }));
});

test("the locale reaches the faker a definition reads", async () => {
  const { f } = await factorioHarness({ locale: "fr", seed: 3 });
  const cities = f.define("user", {
    definition: ({ faker, uid }) => ({ email: `${uid}@example.com`, name: faker.location.city() }),
  });

  const rows = await cities.count(10).create();

  expect(allLocales.fr.location?.city_name).toEqual(expect.arrayContaining(rows.map((row) => row.name)));
});

test("a definition that never reads faker runs with @faker-js/faker absent", async () => {
  const prisma = await disposableClient();
  const f = await factorioWithoutFaker(prisma);

  const user = await f.define("user", { definition: userDefinition }).create();

  expect(user.name).toBe("Ada");
});

// Asserted on the guidance rather than on the package name: the absent package names itself in its
// own import failure, so only the guidance tells the library's error apart from a propagated one.
test("reading faker with @faker-js/faker absent names what to install", async () => {
  const prisma = await disposableClient();
  const f = await factorioWithoutFaker(prisma);
  const people = f.define("user", {
    definition: ({ faker, uid }) => ({ email: `${uid}@e.com`, name: faker.person.fullName() }),
  });

  await expect(people.create()).rejects.toThrow(/Install it \(for example `pnpm add -D @faker-js\/faker`\)/);
});
