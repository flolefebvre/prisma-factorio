import { allLocales } from "@faker-js/faker";
import { afterEach, expect, test, vi } from "vitest";
import { createFakerProvider, type FactorioOptions, type FakerProvider } from "./faker.js";

async function sample(options?: FactorioOptions): Promise<string[]> {
  const faker = await createFakerProvider(options)();
  return [faker.person.firstName(), faker.internet.email(), faker.location.city()];
}

// The provider imports @faker-js/faker lazily, so a mock registered here still reaches it — but only
// through a module registry reset, which also clears the memoised resolution of earlier tests.
async function providerWithoutFaker(): Promise<FakerProvider> {
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
