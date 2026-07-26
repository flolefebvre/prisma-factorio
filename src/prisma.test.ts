import { expect, expectTypeOf, test } from "vitest";
import type { Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type {
  Child,
  ChildModel,
  ChildValue,
  CreateInput,
  HasManyArgs,
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

// Stands in for the options object `has` takes, which the factory owns.
interface InverseOption {
  inverse?: string;
}

type Batched<M extends ModelName<TestClient>> = Factory<TestClient, M, Row<TestClient, M>[]>;

test("a model name is a delegate the client carries", () => {
  expectTypeOf<ModelName<TestClient>>().toEqualTypeOf<"user" | "post" | "comment" | "tag" | "team" | "membership">();
});

test("a row carries the model's scalars and none of its relations", () => {
  expectTypeOf<Row<TestClient, "user">>().toEqualTypeOf<UserRow>();
  expectTypeOf<CreateInput<TestClient, "user">>().toExtend<{ email: string }>();
});

test("a relation key is a field pointing at another model, and never a scalar the model holds", () => {
  expectTypeOf<RelationKey<TestClient, "post">>().toEqualTypeOf<"author" | "editor" | "comments" | "tags">();
  expectTypeOf<RelationKey<TestClient, "user">>().toEqualTypeOf<"posts" | "edited" | "memberships">();
  expectTypeOf<RelationKey<TestClient, "comment">>().toEqualTypeOf<"post">();
});

test("a relation key names the model it points at, whether it holds one record or many", () => {
  expectTypeOf<TargetModel<TestClient, "post", "author">>().toEqualTypeOf<"user">();
  expectTypeOf<TargetModel<TestClient, "post", "editor">>().toEqualTypeOf<"user">();
  expectTypeOf<TargetModel<TestClient, "post", "comments">>().toEqualTypeOf<"comment">();
  expectTypeOf<TargetModel<TestClient, "user", "posts">>().toEqualTypeOf<"post">();
  expectTypeOf<TargetModel<TestClient, "comment", "post">>().toEqualTypeOf<"post">();
  expectTypeOf<TargetModel<TestClient, "post", "tags">>().toEqualTypeOf<"tag">();
  expectTypeOf<TargetModel<TestClient, "tag", "posts">>().toEqualTypeOf<"post">();
});

// The hidden join table of an implicit many-to-many carries no model, so the pair is read as an
// ordinary relation whose two sides both hold many records.
test("an implicit many-to-many answers a has-many side at both ends and a belongs-to side at neither", () => {
  expectTypeOf<RelationsTo<TestClient, "post", "tag", true>>().toEqualTypeOf<"tags">();
  expectTypeOf<RelationsTo<TestClient, "tag", "post", true>>().toEqualTypeOf<"posts">();
  expectTypeOf<RelationsTo<TestClient, "post", "tag">>().toBeNever();
  expectTypeOf<RelationsTo<TestClient, "tag", "post">>().toBeNever();
});

// There is no sensible end to call `for()` from: the error is the type layer reporting that, and the
// answer for a many-to-many is `has()` from whichever end reads better.
test("for() takes an argument no relation field satisfies at either end of a many-to-many", () => {
  expectTypeOf<RelationArgs<TestClient, "post", "tag">>().toEqualTypeOf<
    [relationField: 'ERROR: no belongs-to relation from "post" to "tag"']
  >();
  expectTypeOf<RelationArgs<TestClient, "tag", "post">>().toEqualTypeOf<
    [relationField: 'ERROR: no belongs-to relation from "tag" to "post"']
  >();
});

test("has() leaves the relation field skippable at both ends of a many-to-many", () => {
  expectTypeOf<HasManyArgs<TestClient, "post", "tag", InverseOption>>().toEqualTypeOf<
    [relationField?: "tags", options?: InverseOption] | [options: InverseOption]
  >();
  expectTypeOf<HasManyArgs<TestClient, "tag", "post", InverseOption>>().toEqualTypeOf<
    [relationField?: "posts", options?: InverseOption] | [options: InverseOption]
  >();
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

test("a child value is a factory of the model, batched or not, a row of it, or an array of rows", () => {
  expectTypeOf<Factory<TestClient, "comment">>().toExtend<Child<TestClient, "comment">>();
  expectTypeOf<Batched<"comment">>().toExtend<Child<TestClient, "comment">>();
  expectTypeOf<Row<TestClient, "comment">>().toExtend<Child<TestClient, "comment">>();
  expectTypeOf<readonly Row<TestClient, "comment">[]>().toExtend<Child<TestClient, "comment">>();
});

test("a value of another model stands for no child of the model", () => {
  expectTypeOf<Factory<TestClient, "user">>().not.toExtend<Child<TestClient, "comment">>();
  expectTypeOf<Row<TestClient, "user">>().not.toExtend<Child<TestClient, "comment">>();
  expectTypeOf<readonly Row<TestClient, "user">[]>().not.toExtend<Child<TestClient, "comment">>();
});

test("the model a child value stands for is recovered from the value's own type", () => {
  expectTypeOf<ChildModel<TestClient, Factory<TestClient, "comment">>>().toEqualTypeOf<"comment">();
  expectTypeOf<ChildModel<TestClient, Batched<"comment">>>().toEqualTypeOf<"comment">();
  expectTypeOf<ChildModel<TestClient, Row<TestClient, "comment">>>().toEqualTypeOf<"comment">();
  expectTypeOf<ChildModel<TestClient, readonly Row<TestClient, "comment">[]>>().toEqualTypeOf<"comment">();
  expectTypeOf<
    ChildModel<TestClient, Factory<TestClient, "comment", Row<TestClient, "comment">[], { pending: unknown }>>
  >().toEqualTypeOf<"comment">();
  expectTypeOf<ChildModel<TestClient, string>>().toBeNever();
});

// The relation field is the parent-side one, so a pair sharing exactly one has-many relation also
// takes the options object on its own — which is what keeps the tuple a union rather than a spread.
test("the has-many arguments carry a trailing options object, reachable with the relation field or without", () => {
  expectTypeOf<HasManyArgs<TestClient, "post", "comment", InverseOption>>().toEqualTypeOf<
    [relationField?: "comments", options?: InverseOption] | [options: InverseOption]
  >();
  expectTypeOf<HasManyArgs<TestClient, "user", "post", InverseOption>>().toEqualTypeOf<
    [relationField: "posts" | "edited", options?: InverseOption]
  >();
});

test("the has-many arguments reject a relation read at the wrong arity, and a pair sharing none", () => {
  expectTypeOf<HasManyArgs<TestClient, "comment", "post", InverseOption>>().toEqualTypeOf<
    [relationField: 'ERROR: no has-many relation from "comment" to "post"', options?: InverseOption]
  >();
  expectTypeOf<HasManyArgs<TestClient, "comment", "user", InverseOption>>().toEqualTypeOf<
    [relationField: 'ERROR: no has-many relation from "comment" to "user"', options?: InverseOption]
  >();
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

// The argument tuple `has` takes, standing on its own: the tuple resolves the same wherever the
// method it belongs to sits, and the factory it belongs to is declared elsewhere.
declare function hasChildren<M extends ModelName<TestClient>, T extends ChildValue<TestClient>>(
  model: M,
  children: T,
  ...args: HasManyArgs<TestClient, M, ChildModel<TestClient, T>, InverseOption>
): void;

// Held rather than written at the call site: excess property checking reaches a fresh object literal
// only, so a literal would be rejected whether the options object is typed or not.
declare const inverseOption: InverseOption;
declare const misspeltOption: { invrese: string };

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
  comments: Factory<TestClient, "comment">,
  commentRows: Row<TestClient, "comment">[],
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
  // @ts-expect-error a batched factory creates a row each, so it stands for no one record
  f.define("post", { definition: ({ uid }) => ({ title: uid, author: users.count(3) }) });
  // @ts-expect-error a batched factory in overrides stands for no one record either
  void posts.create({ author: users.count(3) });

  hasChildren("post", comments);
  hasChildren("post", comments.count(3));
  hasChildren("post", commentRows);
  hasChildren("post", comments, "comments");
  hasChildren("post", comments, inverseOption);
  hasChildren("post", comments, "comments", inverseOption);
  hasChildren("user", posts.count(3), "posts");
  hasChildren("user", posts.count(3), "edited", inverseOption);

  // @ts-expect-error the pair shares two has-many relations, so the relation field has to be named
  hasChildren("user", posts.count(3));
  // @ts-expect-error the options object stands in for no relation field where one has to be named
  hasChildren("user", posts.count(3), inverseOption);
  // @ts-expect-error a relation field the parent model does not declare
  hasChildren("post", comments, "commnets");
  // @ts-expect-error an option key the options object does not declare
  hasChildren("post", comments, "comments", misspeltOption);
  // @ts-expect-error the relation the pair shares holds one record, not many
  hasChildren("comment", posts, "post");
  // @ts-expect-error the pair shares no relation at either arity
  hasChildren("comment", users);
}
