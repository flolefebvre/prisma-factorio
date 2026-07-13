import { expect, expectTypeOf, test, vi } from "vitest";
import { Factory, initPrismaFactorio, PrismaFactorioNotInitializedError } from "./index.ts";

interface BookCreateInput {
  title: string;
  pages?: number;
}

interface BookModel {
  id: number;
  title: string;
  pages: number | null;
}

class BookFactory extends Factory<BookCreateInput, BookModel> {
  protected readonly prismaDelegate = "book";

  definition(): BookCreateInput {
    return { title: "The Pragmatic Programmer" };
  }
}

const persistedBook: BookModel = { id: 1, title: "The Pragmatic Programmer", pages: null };

function fakeClient(row: BookModel) {
  const create = vi.fn(() => Promise.resolve(row));
  return { client: { book: { create } }, create };
}

test("make() returns the object built by definition()", () => {
  expect(BookFactory.new().make()).toEqual({ title: "The Pragmatic Programmer" });
});

test("definition() is re-evaluated on every make() call", () => {
  let calls = 0;
  class CountingFactory extends Factory<{ n: number }, { n: number }> {
    protected readonly prismaDelegate = "counting";

    definition(): { n: number } {
      calls += 1;
      return { n: calls };
    }
  }

  const factory = CountingFactory.new();

  expect(factory.make()).toEqual({ n: 1 });
  expect(factory.make()).toEqual({ n: 2 });
});

test("new() returns an instance of the concrete factory subclass", () => {
  expect(BookFactory.new()).toBeInstanceOf(BookFactory);
});

test("create() before initPrismaFactorio rejects with a dedicated error naming initPrismaFactorio", async () => {
  vi.resetModules();
  const fresh = await import("./index.ts");
  class FreshBookFactory extends fresh.Factory<BookCreateInput, BookModel> {
    protected readonly prismaDelegate = "book";

    definition(): BookCreateInput {
      return { title: "The Pragmatic Programmer" };
    }
  }

  await expect(FreshBookFactory.new().create()).rejects.toBeInstanceOf(fresh.PrismaFactorioNotInitializedError);
  await expect(FreshBookFactory.new().create()).rejects.toThrow(
    "No Prisma client is registered. Call initPrismaFactorio({ prisma }) before create().",
  );
});

test("create() rejects with PrismaFactorioNotInitializedError when the registered getter returns undefined", async () => {
  // A non-null-asserted global (`let client!: PrismaClient`) passes the type
  // check yet yields undefined until assigned; the cast reproduces that state.
  initPrismaFactorio({ prisma: () => undefined as unknown as object });

  await expect(BookFactory.new().create()).rejects.toBeInstanceOf(PrismaFactorioNotInitializedError);
  await expect(BookFactory.new().create()).rejects.toThrow(
    "The registered Prisma client getter returned undefined — the client was not yet constructed when create() ran.",
  );
});

test("create() persists { data: make() } through the registered client's model delegate", async () => {
  const { client, create } = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: client });

  const created = await BookFactory.new().create();

  expect(create).toHaveBeenCalledExactlyOnceWith({ data: { title: "The Pragmatic Programmer" } });
  expect(created).toBe(persistedBook);
});

test("a client getter is invoked freshly on every create() call", async () => {
  const { client, create } = fakeClient(persistedBook);
  const getter = vi.fn(() => client);
  initPrismaFactorio({ prisma: getter });

  await BookFactory.new().create();
  await BookFactory.new().create();

  expect(getter).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
});

test("re-initializing replaces the registered client (last wins)", async () => {
  const first = fakeClient(persistedBook);
  const second = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: first.client });
  initPrismaFactorio({ prisma: second.client });

  await BookFactory.new().create();

  expect(first.create).not.toHaveBeenCalled();
  expect(second.create).toHaveBeenCalledTimes(1);
});

test("create() rejects naming the delegate when the registered client lacks it", async () => {
  initPrismaFactorio({ prisma: {} });

  await expect(BookFactory.new().create()).rejects.toThrow(/"book"/);
});

test("create() resolves with the row typed as the factory's model", () => {
  expectTypeOf<ReturnType<BookFactory["create"]>>().resolves.toEqualTypeOf<BookModel>();
  expectTypeOf<BookFactory["create"]>().returns.toEqualTypeOf<Promise<BookModel>>();
});
