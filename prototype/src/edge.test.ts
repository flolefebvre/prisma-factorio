import { expect, it, beforeEach } from "vitest";
import { userFactory } from "./factories.ts";
import { reset } from "./support.ts";

beforeEach(reset);

it("count(1) returns an array, matching its static type", async () => {
  const users = await userFactory.count(1).create();
  expect(Array.isArray(users)).toBe(true);
  expect(users).toHaveLength(1);
});

it("count(0) creates nothing", async () => {
  const users = await userFactory.count(0).create();
  expect(users).toEqual([]);
});

it("make(1) returns an array too", () => {
  const made = userFactory.count(1).make();
  expect(Array.isArray(made)).toBe(true);
});
