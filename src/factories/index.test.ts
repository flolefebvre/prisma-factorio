import { expect, expectTypeOf, test, vi } from "vitest";
import {
  Factory,
  FactoryCycleError,
  type FactoryValue,
  initPrismaFactorio,
  PrismaFactorioNotInitializedError,
  registerFactories,
  RelationDefaultFactoryError,
  resolveRegisteredFactory,
} from "./index.ts";

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

test("count(n).make() returns n CreateInputs built from the pipeline", () => {
  const inputs = BookFactory.new().state({ pages: 42 }).count(3).make();

  expect(inputs).toEqual([
    { title: "The Pragmatic Programmer", pages: 42 },
    { title: "The Pragmatic Programmer", pages: 42 },
    { title: "The Pragmatic Programmer", pages: 42 },
  ]);
});

test("count(n).create() runs n individual delegate.create calls and resolves the rows in order", async () => {
  let call = 0;
  const create = vi.fn(() => {
    call += 1;
    return Promise.resolve({ id: call, title: "The Pragmatic Programmer", pages: null });
  });
  initPrismaFactorio({ prisma: { book: { create } } });

  const created = await BookFactory.new().count(3).create();

  expect(create).toHaveBeenCalledTimes(3);
  expect(create).toHaveBeenCalledWith({ data: { title: "The Pragmatic Programmer" } });
  expect(created.map((row) => row.id)).toEqual([1, 2, 3]);
});

test("count() rejects a negative or non-integer n with a TypeError at chain time", () => {
  expect(() => BookFactory.new().count(-1)).toThrow(TypeError);
  expect(() => BookFactory.new().count(2.5)).toThrow(TypeError);
  expect(() => BookFactory.new().count(Number.NaN)).toThrow(TypeError);
});

test("state() after count() keeps its chain position: it merges over earlier states and reads them in closure form", () => {
  const inputs = BookFactory.new()
    .state({ title: "Early", pages: 1 })
    .count(2)
    .state((attrs) => ({ title: `${attrs.title} Late` }))
    .make();

  expect(inputs).toEqual([
    { title: "Early Late", pages: 1 },
    { title: "Early Late", pages: 1 },
  ]);
});

test("count() after count() — the last count wins", () => {
  expect(BookFactory.new().count(5).count(2).make()).toHaveLength(2);
});

test("each of the n instances re-evaluates the whole pipeline: definition and closure states yield distinct values", () => {
  let definitionCalls = 0;
  class SerialBookFactory extends Factory<BookCreateInput, BookModel> {
    protected readonly prismaDelegate = "book";

    definition(): BookCreateInput {
      definitionCalls += 1;
      return { title: `Copy ${String(definitionCalls)}` };
    }
  }
  let closureCalls = 0;
  const closure = () => {
    closureCalls += 1;
    return { pages: closureCalls };
  };

  const inputs = SerialBookFactory.new().state(closure).count(3).make();

  expect(inputs).toEqual([
    { title: "Copy 1", pages: 1 },
    { title: "Copy 2", pages: 2 },
    { title: "Copy 3", pages: 3 },
  ]);
});

test("counted create() runs sequentially: each delegate call starts only after the previous one settled", async () => {
  let pending = 0;
  let maxPending = 0;
  const create = vi.fn(async () => {
    pending += 1;
    maxPending = Math.max(maxPending, pending);
    await Promise.resolve();
    pending -= 1;
    return persistedBook;
  });
  initPrismaFactorio({ prisma: { book: { create } } });

  await BookFactory.new().count(3).create();

  expect(create).toHaveBeenCalledTimes(3);
  expect(maxPending).toBe(1);
});

test("counted create() resolves a client getter freshly for every one of the n calls", async () => {
  const { client, create } = fakeClient(persistedBook);
  const getter = vi.fn(() => client);
  initPrismaFactorio({ prisma: getter });

  await BookFactory.new().count(3).create();

  expect(getter).toHaveBeenCalledTimes(3);
  expect(create).toHaveBeenCalledTimes(3);
});

test("make(overrides) on a counted factory applies the overrides to every instance, closure form seeing per-instance attributes", () => {
  let n = 0;
  class NumberedBookFactory extends Factory<BookCreateInput, BookModel> {
    protected readonly prismaDelegate = "book";

    definition(): BookCreateInput {
      n += 1;
      return { title: `Vol ${String(n)}` };
    }
  }

  const inputs = NumberedBookFactory.new()
    .count(2)
    .make((attrs) => ({ title: `${attrs.title}!` }));

  expect(inputs).toEqual([{ title: "Vol 1!" }, { title: "Vol 2!" }]);
});

test("count() leaves the receiver untouched: the original factory still makes a single input", () => {
  const factory = BookFactory.new();
  factory.count(3);

  expect(factory.make()).toEqual({ title: "The Pragmatic Programmer" });
});

test("count(0) makes an empty list and create() persists nothing", async () => {
  const { client, create } = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: client });

  expect(BookFactory.new().count(0).make()).toEqual([]);
  expect(await BookFactory.new().count(0).create()).toEqual([]);
  expect(create).not.toHaveBeenCalled();
});

test("count() flips result types to lists — make() to CreateInput[], create() to Promise<Model[]> — with no unions", () => {
  const counted = BookFactory.new().count(2);

  expectTypeOf(counted.make()).toEqualTypeOf<BookCreateInput[]>();
  expectTypeOf(counted.create()).toEqualTypeOf<Promise<BookModel[]>>();
  expectTypeOf(BookFactory.new().make()).toEqualTypeOf<BookCreateInput>();
  expectTypeOf(BookFactory.new().create()).toEqualTypeOf<Promise<BookModel>>();
});

test("sequence(A, B) under count(3) cycles by instance index: A, B, then A again", () => {
  const inputs = BookFactory.new().count(3).sequence({ pages: 100 }, { pages: 200 }).make();

  expect(inputs.map((input) => input.pages)).toEqual([100, 200, 100]);
});

test("sequence() before count() cycles the same way — count and sequence are orthogonal", () => {
  const inputs = BookFactory.new().sequence({ pages: 100 }, { pages: 200 }).count(3).make();

  expect(inputs.map((input) => input.pages)).toEqual([100, 200, 100]);
});

test("the sequence closure receives the 0-based instance index", () => {
  const seen: number[] = [];

  BookFactory.new()
    .count(3)
    .sequence((index) => {
      seen.push(index);
      return { title: `Book ${String(index)}` };
    })
    .make();

  expect(seen).toEqual([0, 1, 2]);
});

test("sequence() without count() builds a single instance from the first value only — the documented truncation pitfall", () => {
  const input = BookFactory.new().sequence({ pages: 100 }, { pages: 200 }).make();

  expect(input).toEqual({ title: "The Pragmatic Programmer", pages: 100 });
});

test("a state after a sequence overrides the sequenced field, and a sequence overrides an earlier state's field", () => {
  const laterStateWins = BookFactory.new().count(2).sequence({ pages: 100 }, { pages: 200 }).state({ pages: 7 }).make();
  const laterSequenceWins = BookFactory.new()
    .state({ pages: 7 })
    .count(2)
    .sequence({ pages: 100 }, { pages: 200 })
    .make();

  expect(laterStateWins.map((input) => input.pages)).toEqual([7, 7]);
  expect(laterSequenceWins.map((input) => input.pages)).toEqual([100, 200]);
});

test("sequence() leaves the receiver untouched and returns an instance of the concrete factory subclass", () => {
  const base = BookFactory.new();
  const sequenced = base.sequence({ pages: 1 });

  expect(base.make()).toEqual({ title: "The Pragmatic Programmer" });
  expect(sequenced).toBeInstanceOf(BookFactory);
  expect(sequenced.make()).toEqual({ title: "The Pragmatic Programmer", pages: 1 });
});

test("counted create() applies the sequence per persisted row", async () => {
  const { client, create } = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: client });

  await BookFactory.new().count(3).sequence({ pages: 100 }, { pages: 200 }).create();

  expect(create).toHaveBeenNthCalledWith(1, { data: { title: "The Pragmatic Programmer", pages: 100 } });
  expect(create).toHaveBeenNthCalledWith(2, { data: { title: "The Pragmatic Programmer", pages: 200 } });
  expect(create).toHaveBeenNthCalledWith(3, { data: { title: "The Pragmatic Programmer", pages: 100 } });
});

test("sequence() requires at least one step, on the factory and after count()", () => {
  // @ts-expect-error — sequence() with no steps has nothing to cycle over
  BookFactory.new().sequence();
  // @ts-expect-error — sequence() with no steps has nothing to cycle over
  BookFactory.new().count(2).sequence();
});

test("the pipeline's bivariant step stays contained: a concrete factory still satisfies the Factory<unknown, unknown> bound that new() constrains on", () => {
  // PipelineStep's method-syntax bivariance exists solely so this holds; a bare
  // function type would make the step parameter contravariant and a concrete
  // factory would fail new()'s `this: new () => Factory<unknown, unknown>`.
  expectTypeOf<BookFactory>().toExtend<Factory<unknown, unknown>>();
});

test("the bivariance never leaks into the public surface: state()/sequence() still reject a closure with an incompatible parameter or return", () => {
  // @ts-expect-error — closure parameter is not the factory's CreateInput
  BookFactory.new().state((attrs: { notAField: string }) => ({ title: attrs.notAField }));
  // @ts-expect-error — closure returns a field the CreateInput does not have
  BookFactory.new().state(() => ({ notAField: 1 }));
  BookFactory.new()
    .count(2)
    // @ts-expect-error — the same soundness holds for the sequence closure
    .sequence(() => ({ notAField: 1 }));
});

test("create() resolves with the row typed as the factory's model", () => {
  expectTypeOf<ReturnType<BookFactory["create"]>>().resolves.toEqualTypeOf<BookModel>();
  expectTypeOf<BookFactory["create"]>().returns.toEqualTypeOf<Promise<BookModel>>();
});

class PinnedRoleFactory extends Factory<BookCreateInput, BookModel> {
  protected readonly prismaDelegate = "book";

  constructor(private readonly role: string) {
    super();
  }

  definition(): BookCreateInput {
    return { title: this.role };
  }
}

test("state() on a factory whose class declares required constructor parameters throws a TypeError naming the class, the count, and the field/named-state alternative", () => {
  const fork = () => new PinnedRoleFactory("boss").state({ pages: 1 });

  expect(fork).toThrow(TypeError);
  expect(fork).toThrow(/PinnedRoleFactory declares 1 required constructor parameter\(s\)/);
  expect(fork).toThrow(/class field|named state/);
});

test("sequence() on a factory with required constructor parameters throws the same fork guard", () => {
  expect(() => new PinnedRoleFactory("boss").sequence({ pages: 1 })).toThrow(
    /PinnedRoleFactory declares 1 required constructor parameter/,
  );
});

test("new() on a class with required constructor parameters throws the fork guard — the plain-JS hole the compile error already closes for TS callers", () => {
  // TS callers cannot reach here: new()'s `this: new () => TFactory` rejects a
  // required-param subclass at compile time. The cast models a plain-JS consumer
  // (or a deliberate `as` cast) that reaches new() and hits the runtime guard.
  const plainJs = PinnedRoleFactory as unknown as { new: () => unknown };

  expect(() => plainJs.new()).toThrow(TypeError);
  expect(() => plainJs.new()).toThrow(/PinnedRoleFactory declares 1 required constructor parameter/);
});

test("a directly-constructed factory with required constructor parameters and no chained states still works — the guard fires only when a fork happens", async () => {
  const { client, create } = fakeClient(persistedBook);
  initPrismaFactorio({ prisma: client });

  expect(new PinnedRoleFactory("boss").make()).toEqual({ title: "boss" });
  expect(new PinnedRoleFactory("boss").count(2).make()).toEqual([{ title: "boss" }, { title: "boss" }]);
  await new PinnedRoleFactory("boss").create();

  expect(create).toHaveBeenCalledExactlyOnceWith({ data: { title: "boss" } });
});

test("registerFactories makes a registered factory resolvable by model name, fresh on each resolve", () => {
  registerFactories({ book: BookFactory });

  const first = resolveRegisteredFactory("book");
  const second = resolveRegisteredFactory("book");

  expect(first).toBeInstanceOf(BookFactory);
  expect(second).toBeInstanceOf(BookFactory);
  expect(first).not.toBe(second);
});

test("registerFactories merges across calls, the last registration winning per model", () => {
  class OtherBookFactory extends BookFactory {}
  registerFactories({ book: BookFactory });
  registerFactories({ book: OtherBookFactory });

  expect(resolveRegisteredFactory("book")).toBeInstanceOf(OtherBookFactory);
});

test("resolving an unregistered model throws FactoryNotRegisteredError naming the model and both remedies", async () => {
  vi.resetModules();
  const fresh = await import("./index.ts");

  const resolve = () => fresh.resolveRegisteredFactory("Post");

  expect(resolve).toThrow(fresh.FactoryNotRegisteredError);
  expect(resolve).toThrow(/model "Post"/);
  expect(resolve).toThrow(/registerFactories\(\{ Post: PostFactory \}\)/);
  expect(resolve).toThrow(/pass a configured factory/);
});

test("registerFactories rejects a factory class with required constructor parameters at resolve time", () => {
  registerFactories({ pinned: PinnedRoleFactory as unknown as new () => Factory<unknown, unknown, unknown> });

  expect(() => resolveRegisteredFactory("pinned")).toThrow(
    /PinnedRoleFactory declares 1 required constructor parameter/,
  );
});

interface AuthorCreateInput {
  name: string;
  country?: string | undefined;
}

interface AuthorModel {
  id: number;
  name: string;
  country: string | null;
}

class AuthorFactory extends Factory<AuthorCreateInput, AuthorModel> {
  protected readonly prismaDelegate = "author";

  definition(): AuthorCreateInput {
    return { name: "Kent Beck" };
  }
}

// A book whose author relation is a Prisma-style nested-create input; the
// definition type widens that field to also accept the author factory.
interface AuthoredBookCreateInput {
  title: string;
  author: { create?: AuthorCreateInput; connect?: { id: number } };
}

type AuthoredBookDefinition = Omit<AuthoredBookCreateInput, "author"> & {
  author: AuthoredBookCreateInput["author"] | FactoryValue<AuthorFactory>;
};

class AuthoredBookFactory extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
  protected readonly prismaDelegate = "book";

  definition(): AuthoredBookDefinition {
    return { title: "TDD by Example", author: AuthorFactory.new() };
  }
}

test("make() resolves a factory-as-value into a nested { create: <child CreateInput> }", () => {
  expect(AuthoredBookFactory.new().make()).toEqual({
    title: "TDD by Example",
    author: { create: { name: "Kent Beck" } },
  });
});

test("the lazy () => factory form resolves identically to the eager form", () => {
  class LazyAuthoredBookFactory extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookDefinition {
      return { title: "TDD by Example", author: () => AuthorFactory.new() };
    }
  }

  expect(LazyAuthoredBookFactory.new().make().author).toEqual({ create: { name: "Kent Beck" } });
});

test("make() on a factory-as-value definition is typed as the model CreateInput, not the widened definition", () => {
  expectTypeOf(AuthoredBookFactory.new().make()).toEqualTypeOf<AuthoredBookCreateInput>();
  expectTypeOf(AuthoredBookFactory.new().create()).resolves.toEqualTypeOf<BookModel>();
});

test("FactoryValue<TFactory> admits the factory instance and a thunk returning it", () => {
  expectTypeOf<AuthorFactory>().toExtend<FactoryValue<AuthorFactory>>();
  expectTypeOf<() => AuthorFactory>().toExtend<FactoryValue<AuthorFactory>>();
});

test("a relation supplied by overrides short-circuits: the nested factory is never evaluated", () => {
  class ThrowingAuthorFactory extends Factory<AuthorCreateInput, AuthorModel> {
    protected readonly prismaDelegate = "author";

    definition(): AuthorCreateInput {
      throw new Error("the nested factory must not be evaluated when the relation is supplied");
    }
  }
  class BookWithThrowingAuthor extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookDefinition {
      return { title: "TDD", author: ThrowingAuthorFactory.new() };
    }
  }

  const supplied = BookWithThrowingAuthor.new().make({ author: { connect: { id: 7 } } });

  expect(supplied.author).toEqual({ connect: { id: 7 } });
});

test("a relation supplied by a state short-circuits the nested factory the same way", () => {
  let evaluated = 0;
  class CountingAuthorFactory extends Factory<AuthorCreateInput, AuthorModel> {
    protected readonly prismaDelegate = "author";

    definition(): AuthorCreateInput {
      evaluated += 1;
      return { name: "Kent Beck" };
    }
  }
  class BookWithCountingAuthor extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookDefinition {
      return { title: "TDD", author: CountingAuthorFactory.new() };
    }
  }

  const supplied = BookWithCountingAuthor.new()
    .state({ author: { connect: { id: 3 } } })
    .make();

  expect(supplied.author).toEqual({ connect: { id: 3 } });
  expect(evaluated).toBe(0);
});

test("create() persists the resolved nested create in a single delegate.create call", async () => {
  const create = vi.fn(() => Promise.resolve(persistedBook));
  initPrismaFactorio({ prisma: { book: { create } } });

  await AuthoredBookFactory.new().create();

  expect(create).toHaveBeenCalledExactlyOnceWith({
    data: { title: "TDD by Example", author: { create: { name: "Kent Beck" } } },
  });
});

// A hand-rolled to-one magic method mirroring the generated `forX`: it names
// the relation field, the target model, its id field, and the method, exactly
// as the generator bakes them.
class MagicBookFactory extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
  protected readonly prismaDelegate = "book";

  definition(): AuthoredBookDefinition {
    return { title: "TDD", author: AuthorFactory.new() };
  }

  forAuthor(arg: AuthorModel | Partial<AuthorCreateInput> | AuthorFactory): this {
    return this.declareToOne("author", "Author", "id", "forAuthor", arg);
  }
}

test("forX(existingRow) connects the row by its id and never evaluates the definition factory", () => {
  class ThrowingAuthorFactory extends Factory<AuthorCreateInput, AuthorModel> {
    protected readonly prismaDelegate = "author";

    definition(): AuthorCreateInput {
      throw new Error("the definition factory must not be evaluated when an existing row is connected");
    }
  }
  class ConnectingBookFactory extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookDefinition {
      return { title: "TDD", author: ThrowingAuthorFactory.new() };
    }

    forAuthor(arg: AuthorModel): this {
      return this.declareToOne("author", "Author", "id", "forAuthor", arg);
    }
  }
  const existing: AuthorModel = { id: 42, name: "Kent Beck", country: "USA" };

  const input = ConnectingBookFactory.new().forAuthor(existing).make();

  expect(input.author).toEqual({ connect: { id: 42 } });
});

test("forX(factory) nests a create built from the passed factory", () => {
  const input = MagicBookFactory.new()
    .forAuthor(AuthorFactory.new().state({ name: "Martin Fowler" }))
    .make();

  expect(input.author).toEqual({ create: { name: "Martin Fowler" } });
});

test("forX(overrides) applies the overrides as a state on the definition's factory-as-value", () => {
  const input = MagicBookFactory.new().forAuthor({ country: "UK" }).make();

  expect(input.author).toEqual({ create: { name: "Kent Beck", country: "UK" } });
});

test("forX(overrides) throws RelationDefaultFactoryError when the definition holds no factory for the relation", () => {
  class PlainAuthorBookFactory extends Factory<AuthoredBookCreateInput, BookModel, AuthoredBookDefinition> {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookDefinition {
      return { title: "TDD", author: { connect: { id: 1 } } };
    }

    forAuthor(arg: Partial<AuthorCreateInput>): this {
      return this.declareToOne("author", "Author", "id", "forAuthor", arg);
    }
  }

  const build = () => PlainAuthorBookFactory.new().forAuthor({ country: "UK" }).make();

  expect(build).toThrow(RelationDefaultFactoryError);
  expect(build).toThrow(/relation "author"/);
  expect(build).toThrow(/forAuthor\(\)/);
});

test("forX returns a copy: the receiver keeps the definition's own author", () => {
  const base = MagicBookFactory.new();
  const connected = base.forAuthor({ id: 7, name: "Erich", country: null });

  expect(base.make().author).toEqual({ create: { name: "Kent Beck" } });
  expect(connected.make().author).toEqual({ connect: { id: 7 } });
});

test("forX loads the relation into the create call's include so the return carries it", async () => {
  const create = vi.fn(() => Promise.resolve(persistedBook));
  initPrismaFactorio({ prisma: { book: { create } } });

  await MagicBookFactory.new().forAuthor({ id: 9, name: "Grace", country: null }).create();

  expect(create).toHaveBeenCalledExactlyOnceWith({
    data: { title: "TDD", author: { connect: { id: 9 } } },
    include: { author: true },
  });
});

test("resolution recurses: a factory-as-value nested inside a resolved child is itself resolved", () => {
  interface AgentCreateInput {
    name: string;
  }
  class AgentFactory extends Factory<AgentCreateInput, { id: number }> {
    protected readonly prismaDelegate = "agent";

    definition(): AgentCreateInput {
      return { name: "Sue" };
    }
  }
  interface AgentedAuthorCreateInput {
    name: string;
    agent: { create?: AgentCreateInput };
  }
  type AgentedAuthorDefinition = Omit<AgentedAuthorCreateInput, "agent"> & {
    agent: AgentedAuthorCreateInput["agent"] | FactoryValue<AgentFactory>;
  };
  class AgentedAuthorFactory extends Factory<AgentedAuthorCreateInput, AuthorModel, AgentedAuthorDefinition> {
    protected readonly prismaDelegate = "author";

    definition(): AgentedAuthorDefinition {
      return { name: "Erich", agent: AgentFactory.new() };
    }
  }
  interface AuthoredBookWithAgentDefinition {
    title: string;
    author: { create?: AgentedAuthorCreateInput } | FactoryValue<AgentedAuthorFactory>;
  }
  class DeepBookFactory extends Factory<
    { title: string; author: { create?: AgentedAuthorCreateInput } },
    BookModel,
    AuthoredBookWithAgentDefinition
  > {
    protected readonly prismaDelegate = "book";

    definition(): AuthoredBookWithAgentDefinition {
      return { title: "Patterns", author: AgentedAuthorFactory.new() };
    }
  }

  expect(DeepBookFactory.new().make()).toEqual({
    title: "Patterns",
    author: { create: { name: "Erich", agent: { create: { name: "Sue" } } } },
  });
});

interface ChickenCreateInput {
  name: string;
  egg: { create?: EggCreateInput; connect?: { id: number } };
}

interface EggCreateInput {
  code: string;
  chicken: { create?: ChickenCreateInput; connect?: { id: number } };
}

type ChickenDefinition = Omit<ChickenCreateInput, "egg"> & {
  egg: ChickenCreateInput["egg"] | FactoryValue<EggFactory>;
};

type EggDefinition = Omit<EggCreateInput, "chicken"> & {
  chicken: EggCreateInput["chicken"] | FactoryValue<ChickenFactory>;
};

class ChickenFactory extends Factory<ChickenCreateInput, { id: number }, ChickenDefinition> {
  protected readonly prismaDelegate = "chicken";

  definition(): ChickenDefinition {
    return { name: "Hen", egg: EggFactory.new() };
  }
}

class EggFactory extends Factory<EggCreateInput, { id: number }, EggDefinition> {
  protected readonly prismaDelegate = "egg";

  definition(): EggDefinition {
    return { code: "E-1", chicken: ChickenFactory.new() };
  }
}

test("a definition-level cycle between two required-relation factories throws FactoryCycleError naming the cycle", () => {
  expect(() => ChickenFactory.new().make()).toThrow(FactoryCycleError);
  expect(() => ChickenFactory.new().make()).toThrow(/ChickenFactory.*EggFactory.*ChickenFactory/);
});

test("a self-referential definition throws FactoryCycleError instead of overflowing the stack", () => {
  interface NodeCreateInput {
    label: string;
    next: { create?: NodeCreateInput };
  }
  type NodeDefinition = Omit<NodeCreateInput, "next"> & {
    next: NodeCreateInput["next"] | FactoryValue<NodeFactory>;
  };
  class NodeFactory extends Factory<NodeCreateInput, { id: number }, NodeDefinition> {
    protected readonly prismaDelegate = "node";

    definition(): NodeDefinition {
      return { label: "root", next: NodeFactory.new() };
    }
  }

  expect(() => NodeFactory.new().make()).toThrow(FactoryCycleError);
});

test("a constructor with only default parameters passes the guard but its value resets on the first fork — the documented residual hole", () => {
  class DefaultRoleFactory extends Factory<BookCreateInput, BookModel> {
    protected readonly prismaDelegate = "book";

    constructor(private readonly role = "member") {
      super();
    }

    definition(): BookCreateInput {
      return { title: this.role };
    }
  }

  // A default parameter does not count toward `length`, so the guard stays
  // silent and a directly-constructed value survives an unforked make().
  expect(new DefaultRoleFactory("admin").make()).toEqual({ title: "admin" });
  // The first fork reconstructs with no arguments, resetting role to its
  // default — the hole `length` cannot close, locked here as known behavior.
  expect(new DefaultRoleFactory("admin").state({ pages: 1 }).make()).toEqual({ title: "member", pages: 1 });
});

// A hand-rolled to-many magic method mirroring the generated `hasX`: it names
// the relation field, the target model, and the child's back-reference field.
interface KidCreateInput {
  label: string;
  parent?: unknown;
}
class KidFactory extends Factory<KidCreateInput, { id: number }> {
  protected readonly prismaDelegate = "kid";

  definition(): KidCreateInput {
    return { label: "kid" };
  }
}
class ParentFactory extends Factory<{ topic: string; kids?: unknown }, { id: number }> {
  protected readonly prismaDelegate = "parent";

  definition(): { topic: string; kids?: unknown } {
    return { topic: "science" };
  }

  hasKids(arg: unknown, overrides?: unknown): this {
    return this.declareToMany("kids", "Kid", "parent", arg, overrides);
  }
}

test("hasX(n) builds n children from the registered default factory, applying uniform overrides", () => {
  registerFactories({ Kid: KidFactory });

  const input = ParentFactory.new().hasKids(3, { label: "override" }).make() as {
    kids: { create: { label: string }[] };
  };

  expect(input.kids.create).toHaveLength(3);
  expect(input.kids.create.map((kid) => kid.label)).toEqual(["override", "override", "override"]);
});

test("hasX(factory) and hasX(listFactory) expand to one child per instance, per-instance state applied", () => {
  const single = ParentFactory.new()
    .hasKids(KidFactory.new().state({ label: "one" }))
    .make() as {
    kids: { create: { label: string }[] };
  };
  const list = ParentFactory.new()
    .hasKids(KidFactory.new().count(3).sequence({ label: "a" }, { label: "b" }))
    .make() as { kids: { create: { label: string }[] } };

  expect(single.kids.create.map((kid) => kid.label)).toEqual(["one"]);
  expect(list.kids.create.map((kid) => kid.label)).toEqual(["a", "b", "a"]);
});

test("hasX(factories[]) builds one child per array element, each keeping its own configuration", () => {
  const input = ParentFactory.new()
    .hasKids([KidFactory.new().state({ label: "x" }), KidFactory.new().state({ label: "y" })])
    .make() as { kids: { create: { label: string }[] } };

  expect(input.kids.create.map((kid) => kid.label)).toEqual(["x", "y"]);
});

test("a to-many child state closure receives the parent's evaluated attributes as its second argument", () => {
  const input = ParentFactory.new()
    .state({ topic: "biology" })
    .hasKids(
      KidFactory.new()
        .count(2)
        .state((_attrs, parent: { topic: string }) => ({ label: `re: ${parent.topic}` })),
    )
    .make() as { kids: { create: { label: string }[] } };

  expect(input.kids.create.map((kid) => kid.label)).toEqual(["re: biology", "re: biology"]);
});

test("a to-many drops the child's back-reference to the parent so the nesting does not re-create it", () => {
  class BackReffingKidFactory extends Factory<KidCreateInput, { id: number }> {
    protected readonly prismaDelegate = "kid";

    definition(): KidCreateInput {
      return { label: "kid", parent: ParentFactory.new() };
    }
  }

  const input = ParentFactory.new().hasKids([BackReffingKidFactory.new()]).make() as {
    kids: { create: Record<string, unknown>[] };
  };

  expect(input.kids.create[0]).toEqual({ label: "kid" });
  expect(input.kids.create[0]).not.toHaveProperty("parent");
});

test("hasX(n) without a registered factory throws FactoryNotRegisteredError at build time", async () => {
  vi.resetModules();
  const fresh = await import("./index.ts");
  class FreshParentFactory extends fresh.Factory<{ name: string; kids?: unknown }, { id: number }> {
    protected readonly prismaDelegate = "parent";

    definition(): { name: string; kids?: unknown } {
      return { name: "p" };
    }

    hasKids(arg: unknown): this {
      return this.declareToMany("kids", "UnregisteredChild", "", arg, undefined);
    }
  }

  expect(() => FreshParentFactory.new().hasKids(2).make()).toThrow(fresh.FactoryNotRegisteredError);
  expect(() => FreshParentFactory.new().hasKids(2).make()).toThrow(/model "UnregisteredChild"/);
});
