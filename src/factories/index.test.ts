import { expect, expectTypeOf, test, vi } from "vitest";
import { Factory, initPrismaFactorio, PrismaFactorioNotInitializedError } from "./index.ts";

interface BookCreateInput {
  title: string;
  pages?: number | undefined;
  author?: { name: string; country?: string };
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

test("state(partial) merges the partial over definition() in make()", () => {
  expect(BookFactory.new().state({ pages: 320 }).make()).toEqual({
    title: "The Pragmatic Programmer",
    pages: 320,
  });
});

test("the pipeline runs definition() first, then states in chain order, then make(overrides) last, last value winning per field", () => {
  const input = BookFactory.new().state({ title: "A", pages: 1 }).state({ title: "B" }).make({ pages: 2 });

  expect(input).toEqual({ title: "B", pages: 2 });
});

test("make(overrides) is strictly equivalent to .state(overrides).make(), for the partial and the closure form", () => {
  const partial = { title: "Refactoring" };
  const closure = (attrs: BookCreateInput) => ({ pages: attrs.title.length });

  expect(BookFactory.new().make(partial)).toEqual(BookFactory.new().state(partial).make());
  expect(BookFactory.new().make(closure)).toEqual(BookFactory.new().state(closure).make());
});

test("a closure state receives the attributes evaluated so far: definition plus earlier states", () => {
  const seen: BookCreateInput[] = [];

  const input = BookFactory.new()
    .state({ pages: 100 })
    .state((attrs) => {
      seen.push(attrs);
      return { title: `${attrs.title} (${String(attrs.pages)} pages)` };
    })
    .make();

  expect(seen).toEqual([{ title: "The Pragmatic Programmer", pages: 100 }]);
  expect(input.title).toBe("The Pragmatic Programmer (100 pages)");
});

test("closure states and definition() run at make() time, not while the chain is built", () => {
  let definitionCalls = 0;
  class LazyBookFactory extends BookFactory {
    definition(): BookCreateInput {
      definitionCalls += 1;
      return super.definition();
    }
  }
  const closure = vi.fn(() => ({ pages: 1 }));

  const factory = LazyBookFactory.new().state(closure);

  expect(definitionCalls).toBe(0);
  expect(closure).not.toHaveBeenCalled();

  factory.make();

  expect(definitionCalls).toBe(1);
  expect(closure).toHaveBeenCalledTimes(1);
});

test("merging is shallow: an object-valued field is replaced wholly, never deep-merged", () => {
  const input = BookFactory.new()
    .state({ author: { name: "Kent Beck", country: "USA" } })
    .make({ author: { name: "Martin Fowler" } });

  expect(input.author).toEqual({ name: "Martin Fowler" });
  expect(input.author).not.toHaveProperty("country");
});

test("an explicit undefined in a later state wins with undefined, like a plain object spread", () => {
  const input = BookFactory.new().state({ pages: 100 }).state({ pages: undefined }).make();

  expect("pages" in input).toBe(true);
  expect(input.pages).toBeUndefined();
});

test("state() leaves the receiver untouched: two chains forked from one factory do not contaminate each other", () => {
  const base = BookFactory.new().state({ title: "Base" });

  const hardcover = base.state({ pages: 500 });
  const paperback = base.state({ pages: 300 }).state({ title: "Paperback" });

  expect(base.make()).toEqual({ title: "Base" });
  expect(hardcover.make()).toEqual({ title: "Base", pages: 500 });
  expect(paperback.make()).toEqual({ title: "Paperback", pages: 300 });
});

test("a named state written as an arrow-function class field keeps the states chained before it", () => {
  class ArrowBookFactory extends BookFactory {
    paperback = () => this.state({ pages: 200 });
  }

  const input = ArrowBookFactory.new().state({ title: "Chained" }).paperback().make();

  expect(input).toEqual({ title: "Chained", pages: 200 });
});

test("a subclass holding a native #private field read by definition() survives state() forking", () => {
  class PrivateFieldBookFactory extends Factory<BookCreateInput, BookModel> {
    protected readonly prismaDelegate = "book";

    #defaultTitle = "Domain-Driven Design";

    definition(): BookCreateInput {
      return { title: this.#defaultTitle };
    }
  }

  expect(PrivateFieldBookFactory.new().state({ pages: 500 }).make()).toEqual({
    title: "Domain-Driven Design",
    pages: 500,
  });
});

test("state() returns an instance of the concrete factory subclass, so named states keep chaining", () => {
  expect(BookFactory.new().state({ pages: 1 })).toBeInstanceOf(BookFactory);
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

test("create(overrides) persists the merged payload, equivalent to .state(overrides).create()", async () => {
  const { client, create } = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: client });

  await BookFactory.new().state({ pages: 100 }).create({ title: "Refactoring" });
  await BookFactory.new().state({ pages: 100 }).state({ title: "Refactoring" }).create();

  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenNthCalledWith(1, { data: { title: "Refactoring", pages: 100 } });
  expect(create).toHaveBeenNthCalledWith(2, { data: { title: "Refactoring", pages: 100 } });
});

test("create() rejects naming the delegate when the registered client lacks it", async () => {
  initPrismaFactorio({ prisma: {} });

  await expect(BookFactory.new().create()).rejects.toThrow(/"book"/);
});

test("create() resolves with the row typed as the factory's model", () => {
  expectTypeOf<ReturnType<BookFactory["create"]>>().resolves.toEqualTypeOf<BookModel>();
  expectTypeOf<BookFactory["create"]>().returns.toEqualTypeOf<Promise<BookModel>>();
});
