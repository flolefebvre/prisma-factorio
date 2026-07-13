import { expect, expectTypeOf, test } from "vitest";
import { initPrismaFactorio, PACKAGE_NAME, PrismaFactorioNotInitializedError, type StateInput } from "./index.js";
import * as factories from "./factories/index.ts";

test("package entry point loads", () => {
  expect(PACKAGE_NAME).toBe("prisma-factorio");
});

test("the package root re-exports the factories runtime init API", () => {
  expect(initPrismaFactorio).toBe(factories.initPrismaFactorio);
  expect(PrismaFactorioNotInitializedError).toBe(factories.PrismaFactorioNotInitializedError);
});

test("the package root re-exports the StateInput type", () => {
  expectTypeOf<StateInput<{ title: string }>>().toEqualTypeOf<factories.StateInput<{ title: string }>>();
});
