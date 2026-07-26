import { expect, test } from "vitest";
import * as api from "./index.js";
import type { TestClient } from "./tests/client.js";
import { disposableClient, factorioHarness, userDefinition } from "./tests/factorio.js";

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

// A reusable callback is the reason the config key exists, and a callback held in a variable of its
// own is nameable only from the root — through the same type both attachment points are declared with.
test("a callback written against the published type reaches the config key and the fluent method", async () => {
  const prisma = await disposableClient();
  const seen: number[] = [];
  const announced: api.AfterCreating<TestClient, "user"> = (user, { client }) => {
    seen.push(user.id);
    return client.post.count({ where: { authorId: user.id } });
  };
  const f = api.initPrismaFactorio(prisma);

  await f.define("user", { definition: userDefinition, afterCreating: announced }).afterCreating(announced).create();

  expect(seen).toHaveLength(2);
});

// The escape hatch is spelled only through this options object, so a caller holding one in a
// variable of its own has to be able to name its type from the package root.
test("a has() options object written against the published type reaches the call site", async () => {
  const { prisma, posts, users } = await factorioHarness();
  const options: api.HasOptions = { inverse: "author" };

  const user = await users.has(posts, "posts", options).create();

  await expect(prisma.post.count({ where: { authorId: user.id } })).resolves.toBe(1);
});
