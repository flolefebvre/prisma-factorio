import { expect, expectTypeOf, test } from "vitest";
import type { Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type {
  CreateInput,
  ModelName,
  PartialAttributes,
  RelationArgs,
  RelationKey,
  RelationsTo,
  Row,
  TargetModel,
} from "./prisma.js";
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

test("a relation key is a field pointing at another model, and never a scalar the model holds", () => {
  expectTypeOf<RelationKey<TestClient, "post">>().toEqualTypeOf<"author" | "editor" | "comments">();
  expectTypeOf<RelationKey<TestClient, "user">>().toEqualTypeOf<"posts" | "edited">();
  expectTypeOf<RelationKey<TestClient, "comment">>().toEqualTypeOf<"post">();
});

test("a relation key names the model it points at, whether it holds one record or many", () => {
  expectTypeOf<TargetModel<TestClient, "post", "author">>().toEqualTypeOf<"user">();
  expectTypeOf<TargetModel<TestClient, "post", "editor">>().toEqualTypeOf<"user">();
  expectTypeOf<TargetModel<TestClient, "post", "comments">>().toEqualTypeOf<"comment">();
  expectTypeOf<TargetModel<TestClient, "user", "posts">>().toEqualTypeOf<"post">();
  expectTypeOf<TargetModel<TestClient, "comment", "post">>().toEqualTypeOf<"post">();
});

test("the relations a model pair shares are read at the arity asked for", () => {
  expectTypeOf<RelationsTo<TestClient, "comment", "post">>().toEqualTypeOf<"post">();
  expectTypeOf<RelationsTo<TestClient, "post", "user">>().toEqualTypeOf<"author" | "editor">();
  expectTypeOf<RelationsTo<TestClient, "post", "comment", true>>().toEqualTypeOf<"comments">();
  expectTypeOf<RelationsTo<TestClient, "user", "post", true>>().toEqualTypeOf<"posts" | "edited">();
});

test("a relation holding many records answers no belongs-to side, and neither does a pair sharing none", () => {
  expectTypeOf<RelationsTo<TestClient, "post", "comment">>().toBeNever();
  expectTypeOf<RelationsTo<TestClient, "user", "post">>().toBeNever();
  expectTypeOf<RelationsTo<TestClient, "comment", "user">>().toBeNever();
  expectTypeOf<RelationsTo<TestClient, "comment", "user", true>>().toBeNever();
});

test("a relation field is optional where one relation answers and required where several do", () => {
  expectTypeOf<RelationArgs<TestClient, "comment", "post">>().toEqualTypeOf<[relationField?: "post"]>();
  expectTypeOf<RelationArgs<TestClient, "post", "user">>().toEqualTypeOf<[relationField: "author" | "editor"]>();
});

test("a relation field argument reads the arity it is asked for, naming the side in its error", () => {
  expectTypeOf<RelationArgs<TestClient, "post", "comment", true>>().toEqualTypeOf<[relationField?: "comments"]>();
  expectTypeOf<RelationArgs<TestClient, "user", "post", true>>().toEqualTypeOf<[relationField: "posts" | "edited"]>();
  expectTypeOf<RelationArgs<TestClient, "comment", "user", true>>().toEqualTypeOf<
    [relationField: 'ERROR: no has-many relation from "comment" to "user"']
  >();
});

// Left to itself the no-relation case degrades to `[relationField?: never]`, which every call
// satisfies by passing nothing: `IsUnion<never>` is false, so the union branch does not catch it.
test("a pair with no belongs-to relation takes an argument no relation field satisfies", () => {
  expectTypeOf<RelationArgs<TestClient, "post", "comment">>().toEqualTypeOf<
    [relationField: 'ERROR: no belongs-to relation from "post" to "comment"']
  >();
  expectTypeOf<RelationArgs<TestClient, "comment", "user">>().toEqualTypeOf<
    [relationField: 'ERROR: no belongs-to relation from "comment" to "user"']
  >();
  expectTypeOf<RelationArgs<TestClient, "post", "comment">>().not.toEqualTypeOf<[relationField?: never]>();
});

test("a relation field takes a factory of the model it points at, a row of it, or native relation input", () => {
  type Author = PartialAttributes<TestClient, "post">["author"];

  expectTypeOf<Factory<TestClient, "user">>().toExtend<Author>();
  expectTypeOf<Row<TestClient, "user">>().toExtend<Author>();
  expectTypeOf<{ connect: { id: number } }>().toExtend<Author>();
  expectTypeOf<Factory<TestClient, "post">>().not.toExtend<Author>();
  expectTypeOf<Row<TestClient, "post">>().not.toExtend<Author>();
});

test("a relation field holding many records takes native relation input and nothing else", () => {
  type Posts = PartialAttributes<TestClient, "user">["posts"];

  expectTypeOf<{ connect: { id: number } }>().toExtend<Posts>();
  expectTypeOf<Factory<TestClient, "post">>().not.toExtend<Posts>();
  expectTypeOf<Row<TestClient, "post">>().not.toExtend<Posts>();
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
  userRow: Row<TestClient, "user">,
  postRow: Row<TestClient, "post">,
  stateful: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
): void {
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, posts: { create: { title: "t" } } }) });
  f.define("post", { definition: ({ uid }) => ({ title: uid, author: { connect: { id: 1 } } }) });
  f.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1 }) });
  void users.create({ posts: { create: { title: "t" } } });
  void posts.create({ author: { create: { email: "ada@example.com" } } });
  void users.create({ name: undefined });
  void users.create({ name: named ? "Ada" : undefined });

  f.define("post", { definition: ({ uid }) => ({ title: uid, author: users, editor: userRow }) });
  f.define("post", { definition: ({ uid }) => ({ title: uid, author: stateful }) });
  f.define("comment", { definition: ({ uid }) => ({ body: uid, post: posts }) });
  f.define("comment", { definition: ({ uid }) => ({ body: uid, post: postRow }) });
  f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: { byRow: { author: userRow } },
  });
  void posts.create({ author: users });
  void posts.create({ author: userRow });
  void posts.state({ author: users });
  void posts.state(({ index }) => ({ author: index === 0 ? users : userRow }));

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

  // @ts-expect-error a factory of a model the relation does not point at
  f.define("post", { definition: ({ uid }) => ({ title: uid, author: posts }) });
  // @ts-expect-error a factory standing in a relation field that holds many records
  f.define("user", { definition: ({ uid }) => ({ email: `${uid}@e.com`, posts: posts }) });
  // @ts-expect-error a factory where the model declares a scalar
  f.define("post", { definition: () => ({ title: users, author: users }) });
  // @ts-expect-error a factory on the relation half while the raw foreign key holds the other
  f.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1, author: users }) });
  // @ts-expect-error a state naming a relation field of a model the relation does not point at
  void posts.state({ author: posts });
}
