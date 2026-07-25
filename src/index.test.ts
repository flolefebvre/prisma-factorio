import { expect, test } from "vitest";
import * as api from "./index.js";

test("the package root exports the bootstrap and nothing else at runtime", () => {
  expect(api.initPrismaFactorio).toBeTypeOf("function");
  expect(Object.keys(api)).toStrictEqual(["initPrismaFactorio"]);
});
