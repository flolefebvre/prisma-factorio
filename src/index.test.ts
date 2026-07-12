import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.js";

test("package entry point loads", () => {
  expect(PACKAGE_NAME).toBe("prisma-factorio");
});
