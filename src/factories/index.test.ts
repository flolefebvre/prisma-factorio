import { expect, test } from "vitest";
import { Factory } from "./index.ts";

interface BookCreateInput {
  title: string;
  pages?: number;
}

class BookFactory extends Factory<BookCreateInput> {
  definition(): BookCreateInput {
    return { title: "The Pragmatic Programmer" };
  }
}

test("make() returns the object built by definition()", () => {
  expect(BookFactory.new().make()).toEqual({ title: "The Pragmatic Programmer" });
});

test("definition() is re-evaluated on every make() call", () => {
  let calls = 0;
  class CountingFactory extends Factory<{ n: number }> {
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
