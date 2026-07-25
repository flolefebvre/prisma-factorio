import { expect, test } from "vitest";
import * as api from "./index.js";
import type { TestClient } from "./tests/client.js";

test("the package root exports the bootstrap and nothing else at runtime", () => {
  expect(api.initPrismaFactorio).toBeTypeOf("function");
  expect(Object.keys(api)).toStrictEqual(["initPrismaFactorio"]);
});

// The annotations are the assertion: a name the root stops publishing fails `pnpm typecheck` here.
test("the package root publishes the types a state is written against", () => {
  const suspended: api.StateInput<TestClient, "user"> = { name: null };
  const vip: api.StateInput<TestClient, "user"> = ({ attrs }) => ({ name: attrs.name ?? "Ada" });
  const attrs: api.PartialAttributes<TestClient, "user"> = { name: "Ada" };

  expect([suspended, vip, attrs].map((value) => typeof value)).toStrictEqual(["object", "function", "object"]);
});
