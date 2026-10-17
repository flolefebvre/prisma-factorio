import { allLocales } from "@faker-js/faker";
import { afterEach, expect, test, vi } from "vitest";
import {
  createFakerProvider,
  type FactorioOptions,
  type FakerInstance,
  type ReseedableFakerProvider,
} from "./faker.js";

function drawn(faker: FakerInstance): string[] {
  return [faker.person.firstName(), faker.internet.email(), faker.location.city()];
}

async function sample(options?: FactorioOptions): Promise<string[]> {
  return drawn(await createFakerProvider(options)());
}

// The provider imports @faker-js/faker lazily, so a mock registered here still reaches it — but only
// through a module registry reset, which also clears the memoised resolution of earlier tests.
async function providerWithoutFaker(): Promise<ReseedableFakerProvider> {
  vi.doMock("@faker-js/faker", () => {
    throw new Error("Cannot find package '@faker-js/faker'");
  });
  vi.resetModules();
  const module: typeof import("./faker.js") = await import("./faker.js");
  return module.createFakerProvider();
}

afterEach(() => {
  vi.doUnmock("@faker-js/faker");
  vi.resetModules();
});

test("resolves a faker instance whose generators work", async () => {
  const faker = await createFakerProvider()();

  expect(typeof faker.person.firstName()).toBe("string");
});

test("two providers on the same seed produce the same output", async () => {
  expect(await sample({ seed: 7 })).toStrictEqual(await sample({ seed: 7 }));
});

test("two providers on different seeds produce different output", async () => {
  expect(await sample({ seed: 7 })).not.toStrictEqual(await sample({ seed: 8 }));
});

test("an unrecognised locale name is rejected by name", async () => {
  const provider = createFakerProvider({ locale: "klingon" });

  await expect(provider()).rejects.toThrow(/klingon/);
});

test("a provider resolves once and hands out the one instance", async () => {
  const provider = createFakerProvider();
  const pending = provider();

  expect(provider()).toBe(pending);
  expect(await provider()).toBe(await pending);
});

test("the locale reaches the instance the provider hands out", async () => {
  const faker = await createFakerProvider({ locale: "fr", seed: 3 })();

  const cities = Array.from({ length: 10 }, () => faker.location.city());

  expect(allLocales.fr.location?.city_name).toEqual(expect.arrayContaining(cities));
});

test("a provider still resolves with @faker-js/faker absent", async () => {
  const provider = await providerWithoutFaker();

  const faker = await provider();

  expect(typeof faker).toBe("object");
});

test("reading a generator with @faker-js/faker absent names the missing package", async () => {
  const provider = await providerWithoutFaker();
  const faker = await provider();

  expect(() => faker.person).toThrow(/@faker-js\/faker/);
});

test("a reseed before the provider first resolves seeds the instance it resolves", async () => {
  const provider = createFakerProvider({ seed: 3 });

  provider.reseed(7);

  expect(drawn(await provider())).toStrictEqual(await sample({ seed: 7 }));
});

test("a reseed while the provider is resolving still seeds the instance it resolves", async () => {
  const provider = createFakerProvider({ seed: 3 });
  const pending = provider();

  provider.reseed(7);

  expect(drawn(await pending)).toStrictEqual(await sample({ seed: 7 }));
});

test("a reseed after the provider resolved replays a fresh provider on the new seed", async () => {
  const provider = createFakerProvider({ seed: 3 });
  void drawn(await provider());

  provider.reseed(7);

  expect(drawn(await provider())).toStrictEqual(await sample({ seed: 7 }));
});

test("a reseed without a seed parts company with the seed the provider held", async () => {
  const provider = createFakerProvider({ seed: 7 });
  await provider();

  provider.reseed();

  expect(drawn(await provider())).not.toStrictEqual(await sample({ seed: 7 }));
});

test("a reseed with @faker-js/faker absent is a no-op rather than an error", async () => {
  const provider = await providerWithoutFaker();
  await provider();

  expect(() => {
    provider.reseed(7);
  }).not.toThrow();
});
