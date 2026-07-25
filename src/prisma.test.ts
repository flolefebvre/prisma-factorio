import { expect, expectTypeOf, test } from "vitest";
import type { Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type { CreateInput, ModelName, Row } from "./prisma.js";
import type { TestClient } from "./tests/client.js";
import { factorioHarness } from "./tests/factorio.js";

interface UserRow {
  id: number;
  email: string;
  name: string | null;
}

test("a model name is a delegate the client carries", () => {
  expectTypeOf<ModelName<TestClient>>().toEqualTypeOf<"user" | "post" | "comment">();
});

test("a row carries the model's scalars and none of its relations", () => {
  expectTypeOf<Row<TestClient, "user">>().toEqualTypeOf<UserRow>();
  expectTypeOf<CreateInput<TestClient, "user">>().toExtend<{ email: string }>();
});

test("create() is typed as the model's row and count(n).create() as an array of them", async () => {
  const { users } = await factorioHarness();

  const one = await users.create();
  const many = await users.count(2).create();

  expectTypeOf(one).toEqualTypeOf<UserRow>();
  expectTypeOf(many).toEqualTypeOf<UserRow[]>();
  expect(many).toHaveLength(2);
});

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function checkedByTheCompiler(
  f: Factorio<TestClient>,
  users: Factory<TestClient, "user">,
  posts: Factory<TestClient, "post">,
  named: boolean,
): void {
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, posts: { create: { title: "t" } } }) });
  f.define("post", { definition: ({ uid }) => ({ title: uid, author: { connect: { id: 1 } } }) });
  f.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1 }) });
  void users.create({ posts: { create: { title: "t" } } });
  void posts.create({ author: { create: { email: "ada@example.com" } } });
  void users.create({ name: undefined });
  void users.create({ name: named ? "Ada" : undefined });

  // @ts-expect-error a model name the client does not carry
  f.define("usre", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
  // @ts-expect-error a field the model does not have
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, nmae: "Ada" }) });
  // @ts-expect-error a field given the wrong value type
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, name: 42 }) });
  // @ts-expect-error a required field left out
  f.define("user", { definition: () => ({ name: "Ada" }) });
  // @ts-expect-error a field the nested relation input does not have
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@e.com`, posts: { create: { titel: "t" } } }) });
  // @ts-expect-error both halves of a mutually exclusive relation input at once
  f.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1, author: { connect: { id: 1 } } }) });
  // @ts-expect-error overrides naming a field the model does not have
  void users.create({ nmae: "Ada" });
  // @ts-expect-error overrides giving a field the wrong value type
  void users.create({ name: 42 });
  // @ts-expect-error overrides naming both halves of a mutually exclusive relation input
  void posts.create({ authorId: 1, author: { connect: { id: 1 } } });
  // @ts-expect-error a plain object carries no delegate
  void users.using({});

  const widened: Record<string, unknown> = { nmae: "Ada" };
  // @ts-expect-error a record widened to string keys can name fields the model does not have
  void users.create(widened);
}
