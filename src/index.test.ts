import { expect, test } from "vitest";
import * as api from "./index.js";
import type { TestClient } from "./tests/client.js";
import { disposableClient, userDefinition } from "./tests/factorio.js";

test("the package root exports the bootstrap and nothing else at runtime", () => {
  expect(api.initPrismaFactorio).toBeTypeOf("function");
  expect(Object.keys(api)).toStrictEqual(["initPrismaFactorio"]);
});

// A state written against the published types has to reach both the places a state is applied:
// `satisfies` pins its shape without widening it, which is what keeps the field check alive.
test("a state written against the published types reaches the config and the call site alike", async () => {
  const prisma = await disposableClient();
  const suspended = { name: null } satisfies api.PartialAttributes<TestClient, "user">;
  const vip = ({ attrs }: api.StateContext<TestClient, "user">) => ({ name: `${attrs.name ?? "anonymous"} (VIP)` });
  const f = api.initPrismaFactorio(prisma);

  const user = await f
    .define("user", { definition: userDefinition, states: { suspended } })
    .suspended()
    .state(vip)
    .create();

  expect(user.name).toBe("anonymous (VIP)");
});
