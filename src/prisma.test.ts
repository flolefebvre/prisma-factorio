import { expect, expectTypeOf, test } from "vitest";
import type { Factorio } from "./factorio.js";
import type { Factory } from "./factory.js";
import type {
  Child,
  ChildModel,
  NamedChildField,
  CreateInput,
  ModelName,
  NamedParentField,
  PartialAttributes,
  RelationKey,
  RelationsTo,
  Row,
  SoleChild,
  SoleParent,
  TargetModel,
} from "./prisma.js";
import type { TestClient } from "./tests/client.js";
import type { Prisma } from "./tests/generated/client.js";
import { factorioHarness } from "./tests/factorio.js";

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  handle: string | null;
  meta: Prisma.JsonValue | null;
}

// Stands in for the options object `has` takes, which the factory owns.
interface InverseOption {
  inverse?: string;
}

type Batched<M extends ModelName<TestClient>> = Factory<TestClient, M, Row<TestClient, M>[]>;

test("a model name is a delegate the client carries", () => {
  expectTypeOf<ModelName<TestClient>>().toEqualTypeOf<
    | "user"
    | "post"
    | "comment"
    | "tag"
    | "team"
    | "membership"
    | "badge"
    | "venue"
    | "customer"
    | "booking"
    | "invite"
    | "category"
    | "profile"
  >();
});

test("a row carries the model's scalars and none of its relations", () => {
  expectTypeOf<Row<TestClient, "user">>().toEqualTypeOf<UserRow>();
  expectTypeOf<CreateInput<TestClient, "user">>().toExtend<{ email: string }>();
});

test("a relation key is a field pointing at another model, and never a scalar the model holds", () => {
  expectTypeOf<RelationKey<TestClient, "post">>().toEqualTypeOf<"author" | "editor" | "comments" | "tags">();
  expectTypeOf<RelationKey<TestClient, "user">>().toEqualTypeOf<"posts" | "edited" | "memberships" | "profile">();
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
test("for() takes a parent no value satisfies at either end of a many-to-many", () => {
  expectTypeOf<
    SoleParent<TestClient, "post", Factory<TestClient, "tag">>
  >().toEqualTypeOf<'ERROR: no belongs-to relation from "post" to "tag"'>();
  expectTypeOf<
    SoleParent<TestClient, "tag", Row<TestClient, "post">>
  >().toEqualTypeOf<'ERROR: no belongs-to relation from "tag" to "post"'>();
});

test("has() leaves the relation field skippable at both ends of a many-to-many", () => {
  expectTypeOf<SoleChild<TestClient, "post", Factory<TestClient, "tag">>>().toEqualTypeOf<Factory<TestClient, "tag">>();
  expectTypeOf<SoleChild<TestClient, "tag", Row<TestClient, "post">[]>>().toEqualTypeOf<Row<TestClient, "post">[]>();
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

test("a parent stands as it is where one relation answers, and names the fields to pick where several do", () => {
  expectTypeOf<SoleParent<TestClient, "comment", Row<TestClient, "post">>>().toEqualTypeOf<Row<TestClient, "post">>();
  expectTypeOf<SoleParent<TestClient, "comment", Factory<TestClient, "post">>>().toEqualTypeOf<
    Factory<TestClient, "post">
  >();
  expectTypeOf<
    SoleParent<TestClient, "post", Row<TestClient, "user">>
  >().toEqualTypeOf<'ERROR: "post" has several belongs-to relations to "user": name one of "author" | "editor"'>();
  expectTypeOf<
    SoleParent<TestClient, "post", Factory<TestClient, "user">>
  >().toEqualTypeOf<'ERROR: "post" has several belongs-to relations to "user": name one of "author" | "editor"'>();
});

test("the children a has() call takes read the has-many side, naming that side in their messages", () => {
  expectTypeOf<SoleChild<TestClient, "post", Factory<TestClient, "comment">>>().toEqualTypeOf<
    Factory<TestClient, "comment">
  >();
  expectTypeOf<
    SoleChild<TestClient, "user", Factory<TestClient, "post">>
  >().toEqualTypeOf<'ERROR: "user" has several has-many relations to "post": name one of "posts" | "edited"'>();
  expectTypeOf<
    SoleChild<TestClient, "user", Row<TestClient, "post">[]>
  >().toEqualTypeOf<'ERROR: "user" has several has-many relations to "post": name one of "posts" | "edited"'>();
  expectTypeOf<
    SoleChild<TestClient, "comment", Factory<TestClient, "user">>
  >().toEqualTypeOf<'ERROR: no has-many relation from "comment" to "user"'>();
  expectTypeOf<
    SoleChild<TestClient, "comment", Factory<TestClient, "post">>
  >().toEqualTypeOf<'ERROR: no has-many relation from "comment" to "post"'>();
  expectTypeOf<
    SoleChild<TestClient, "user", { id: number }[]>
  >().toEqualTypeOf<"ERROR: the children are neither a factory nor full rows of any model; a partial object is not a row">();
});

// Left to itself the no-relation case degrades to the value standing as it is: `IsUnion<never>` is
// false, so the several-relations branch does not catch it.
test("a pair with no belongs-to relation takes a parent no value satisfies", () => {
  expectTypeOf<
    SoleParent<TestClient, "post", Factory<TestClient, "comment">>
  >().toEqualTypeOf<'ERROR: no belongs-to relation from "post" to "comment"'>();
  expectTypeOf<
    SoleParent<TestClient, "comment", Row<TestClient, "user">>
  >().toEqualTypeOf<'ERROR: no belongs-to relation from "comment" to "user"'>();
});

test("a value no model answers for takes a parent no value satisfies, naming what a parent is", () => {
  expectTypeOf<
    SoleParent<TestClient, "post", { id: number }>
  >().toEqualTypeOf<"ERROR: the parent is neither a factory of one record nor a full row of any model; a partial object is not a row">();
});

test("a named field is one pointing at the value's model, at the arity the call reads", () => {
  expectTypeOf<NamedParentField<TestClient, "post", Row<TestClient, "user">>>().toEqualTypeOf<"author" | "editor">();
  expectTypeOf<NamedParentField<TestClient, "comment", Factory<TestClient, "post">>>().toEqualTypeOf<"post">();
  expectTypeOf<NamedChildField<TestClient, "user", Factory<TestClient, "post">>>().toEqualTypeOf<"posts" | "edited">();
  expectTypeOf<NamedChildField<TestClient, "post", Row<TestClient, "comment">[]>>().toEqualTypeOf<"comments">();
});

test("a named field reads as a message where the pair shares none, or the value stands for no record", () => {
  expectTypeOf<
    NamedParentField<TestClient, "post", Row<TestClient, "team">>
  >().toEqualTypeOf<'ERROR: no belongs-to relation from "post" to "team"'>();
  expectTypeOf<
    NamedParentField<TestClient, "post", { id: number }>
  >().toEqualTypeOf<"ERROR: the parent is neither a factory of one record nor a full row of any model; a partial object is not a row">();
  expectTypeOf<
    NamedParentField<TestClient, "post", Factory<TestClient, "user", Row<TestClient, "user">[]>>
  >().toEqualTypeOf<"ERROR: the parent is neither a factory of one record nor a full row of any model; a partial object is not a row">();
  expectTypeOf<
    NamedChildField<TestClient, "comment", Factory<TestClient, "post">>
  >().toEqualTypeOf<'ERROR: no has-many relation from "comment" to "post"'>();
  expectTypeOf<
    NamedChildField<TestClient, "user", { id: number }>
  >().toEqualTypeOf<"ERROR: the children are neither a factory nor full rows of any model; a partial object is not a row">();
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

test("a relation field takes a factory of the model it points at, a row of it, or native relation input", () => {
  type Author = PartialAttributes<TestClient, "post">["author"];

  expectTypeOf<Factory<TestClient, "user">>().toExtend<Author>();
  expectTypeOf<Row<TestClient, "user">>().toExtend<Author>();
  expectTypeOf<{ connect: { id: number } }>().toExtend<Author>();
  expectTypeOf<{ create: { email: string } }>().toExtend<Author>();
  expectTypeOf<{ connectOrCreate: { where: { id: number }; create: { email: string } } }>().toExtend<Author>();
  expectTypeOf<Factory<TestClient, "post">>().not.toExtend<Author>();
  expectTypeOf<Row<TestClient, "post">>().not.toExtend<Author>();
});

// Prisma's nested relation input leaves every key optional, and a union holding a row is no weak
// type, so the relation field needs one of those keys named for an object to stand as native input.
test("a relation field takes no object that is neither native relation input nor a value of its model", () => {
  type Author = PartialAttributes<TestClient, "post">["author"];

  expectTypeOf<Row<TestClient, "team">>().not.toExtend<Author>();
  expectTypeOf<{ totallyBogus: number }>().not.toExtend<Author>();
  expectTypeOf<{ email: string; name: string }>().not.toExtend<Author>();
  expectTypeOf<object>().not.toExtend<Author>();
});

test("a relation field holding many records takes a factory, a row, an array of rows, or native input", () => {
  type Posts = PartialAttributes<TestClient, "user">["posts"];

  expectTypeOf<Factory<TestClient, "post">>().toExtend<Posts>();
  expectTypeOf<Batched<"post">>().toExtend<Posts>();
  expectTypeOf<Row<TestClient, "post">>().toExtend<Posts>();
  expectTypeOf<Row<TestClient, "post">[]>().toExtend<Posts>();
  expectTypeOf<{ connect: { id: number } }>().toExtend<Posts>();
  expectTypeOf<{ create: { title: string } }>().toExtend<Posts>();
  expectTypeOf<{ connectOrCreate: { where: { id: number }; create: { title: string } } }>().toExtend<Posts>();
  expectTypeOf<{ createMany: { data: { title: string }[] } }>().toExtend<Posts>();
  expectTypeOf<Factory<TestClient, "user">>().not.toExtend<Posts>();
  expectTypeOf<Row<TestClient, "user">>().not.toExtend<Posts>();
  expectTypeOf<Row<TestClient, "user">[]>().not.toExtend<Posts>();
});

test("a relation field holding many records takes no wrong-model row, no list of them and no list of factories", () => {
  type Posts = PartialAttributes<TestClient, "user">["posts"];

  expectTypeOf<Row<TestClient, "team">>().not.toExtend<Posts>();
  expectTypeOf<Row<TestClient, "team">[]>().not.toExtend<Posts>();
  expectTypeOf<Factory<TestClient, "team">[]>().not.toExtend<Posts>();
  expectTypeOf<Factory<TestClient, "post">[]>().not.toExtend<Posts>();
  expectTypeOf<{ totallyBogus: number }>().not.toExtend<Posts>();
  expectTypeOf<object>().not.toExtend<Posts>();
});

test("create() is typed as the model's row and count(n).create() as an array of them", async () => {
  const { userFactory } = await factorioHarness();

  const one = await userFactory.create();
  const many = await userFactory.count(2).create();

  expectTypeOf(one).toEqualTypeOf<UserRow>();
  expectTypeOf(many).toEqualTypeOf<UserRow[]>();
  expect(many).toHaveLength(2);
});

// Held rather than written at the call site: excess property checking reaches a fresh object literal
// only, so a literal would be rejected whether the options object is typed or not.
declare const inverseOption: InverseOption;
declare const misspeltOption: { invrese: string };

// Never invoked: these calls exist for `pnpm typecheck`, which reads this file. Each directive fails
// the gate the moment the type it names stops rejecting — or stops accepting — what it is given.
export function checkedByTheCompiler(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  named: boolean,
  userRow: Row<TestClient, "user">,
  postRow: Row<TestClient, "post">,
  postRows: Row<TestClient, "post">[],
  statefulFactory: Factory<TestClient, "user", Row<TestClient, "user">, { suspended: unknown }>,
  commentFactory: Factory<TestClient, "comment">,
  commentRows: Row<TestClient, "comment">[],
  teamFactory: Factory<TestClient, "team">,
  inviteFactory: Factory<TestClient, "invite">,
): void {
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@example.com`, posts: { create: { title: "t" } } }),
  });
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: { connect: { id: 1 } } }) });
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1 }) });
  void userFactory.create({ posts: { create: { title: "t" } } });
  void postFactory.create({ author: { create: { email: "ada@example.com" } } });
  void userFactory.create({ name: undefined });
  void userFactory.create({ name: named ? "Ada" : undefined });

  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory, editor: userRow }) });
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: statefulFactory }) });
  prismaFactorio.define("comment", { definition: ({ uid }) => ({ body: uid, post: postFactory }) });
  prismaFactorio.define("comment", { definition: ({ uid }) => ({ body: uid, post: postRow }) });
  prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: { byRow: { author: userRow } },
  });
  void postFactory.create({ author: userFactory });
  void postFactory.create({ author: userRow });
  void postFactory.state({ author: userFactory });
  void postFactory.state(({ index }) => ({ author: index === 0 ? userFactory : userRow }));

  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@e.com`, posts: postFactory, edited: postRow }),
  });
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `${uid}@e.com`, memberships: [], posts: postFactory.count(3) }),
  });
  void userFactory.create({ posts: postRows });
  void userFactory.state({ edited: postFactory.count(3) });

  // @ts-expect-error a model name the client does not carry
  prismaFactorio.define("usre", { definition: ({ uid }) => ({ email: `${uid}@example.com` }) });
  // @ts-expect-error a field the model does not have
  prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, nmae: "Ada" }) });
  // @ts-expect-error a field given the wrong value type
  prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@example.com`, name: 42 }) });
  // @ts-expect-error a required field left out
  prismaFactorio.define("user", { definition: () => ({ name: "Ada" }) });
  prismaFactorio.define("user", {
    // @ts-expect-error a field the nested relation input does not have
    definition: ({ uid }) => ({ email: `${uid}@e.com`, posts: { create: { titel: "t" } } }),
  });
  prismaFactorio.define("post", {
    // @ts-expect-error both halves of a mutually exclusive relation input at once
    definition: ({ uid }) => ({ title: uid, authorId: 1, author: { connect: { id: 1 } } }),
  });
  // @ts-expect-error overrides naming a field the model does not have
  void userFactory.create({ nmae: "Ada" });
  // @ts-expect-error overrides giving a field the wrong value type
  void userFactory.create({ name: 42 });
  // @ts-expect-error overrides naming both halves of a mutually exclusive relation input
  void postFactory.create({ authorId: 1, author: { connect: { id: 1 } } });
  // @ts-expect-error both halves under an id the client generates, which keeps the checked input open
  void inviteFactory.create({ teamId: 1, team: { connect: { id: 1 } } });
  // @ts-expect-error both halves beside an explicit client-generated id
  void inviteFactory.create({ id: "3f2c9e1a-0b7d-4c55-9a8e-6d1f2b3c4d5e", teamId: 1, team: { connect: { id: 1 } } });
  // @ts-expect-error a plain object carries no delegate
  void userFactory.using({});

  const widened: Record<string, unknown> = { nmae: "Ada" };
  // @ts-expect-error a record widened to string keys can name fields the model does not have
  void userFactory.create(widened);

  // @ts-expect-error a factory of a model the relation does not point at
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: postFactory }) });
  // @ts-expect-error a factory of a model the has-many relation does not point at
  prismaFactorio.define("user", { definition: ({ uid }) => ({ email: `${uid}@e.com`, posts: commentFactory }) });
  // @ts-expect-error a factory where the model declares a scalar
  prismaFactorio.define("post", { definition: () => ({ title: userFactory, author: userFactory }) });
  // @ts-expect-error a factory on the relation half while the raw foreign key holds the other
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, authorId: 1, author: userFactory }) });
  // @ts-expect-error the same clash on a model whose id the client generates
  prismaFactorio.define("invite", { definition: ({ uid }) => ({ code: uid, teamId: 1, team: teamFactory }) });
  // @ts-expect-error a state naming a relation field of a model the relation does not point at
  void postFactory.state({ author: postFactory });
  // @ts-expect-error a batched factory creates a row each, so it stands for no one record
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory.count(3) }) });
  // @ts-expect-error a batched factory in overrides stands for no one record either
  void postFactory.create({ author: userFactory.count(3) });

  void postFactory.has(commentFactory);
  void postFactory.has(commentFactory.count(3));
  void postFactory.has(commentRows);
  void postFactory.has(commentFactory, "comments");
  void postFactory.has(commentFactory, inverseOption);
  void postFactory.has(commentFactory, "comments", inverseOption);
  void userFactory.has(postFactory.count(3), "posts");
  void userFactory.has(postFactory.count(3), "edited", inverseOption);

  // @ts-expect-error the pair shares two has-many relations, so the relation field has to be named
  void userFactory.has(postFactory.count(3));
  // @ts-expect-error the options object stands in for no relation field where one has to be named
  void userFactory.has(postFactory.count(3), inverseOption);
  // @ts-expect-error a relation field the parent model does not declare
  void postFactory.has(commentFactory, "commnets");
  // @ts-expect-error an option key the options object does not declare
  void postFactory.has(commentFactory, "comments", misspeltOption);
  // @ts-expect-error the relation the pair shares holds one record, not many
  void commentFactory.has(postFactory, "post");
  // @ts-expect-error the pair shares no relation at either arity
  void commentFactory.has(userFactory);
}

// Never invoked, like the function above. A relation field is reached by four routes — a definition,
// a declared state, `.state()` and `create()` overrides — and each is checked here at both arities.
export function relationValuesByRoute(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  teamFactory: Factory<TestClient, "team">,
  userRow: Row<TestClient, "user">,
  postRows: Row<TestClient, "post">[],
  teamRow: Row<TestClient, "team">,
  bogus: { totallyBogus: number },
): void {
  prismaFactorio.define("post", {
    definition: ({ uid }) => ({
      title: uid,
      author: { connectOrCreate: { where: { id: 1 }, create: { email: uid } } },
    }),
    states: { native: { author: { connect: { id: 1 } } }, byRow: { author: userRow } },
  });
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: uid, posts: { createMany: { data: [{ title: uid }] } } }),
    states: { batched: { posts: postFactory.count(2) }, byRows: { posts: postRows } },
  });
  void postFactory.state({ author: { connectOrCreate: { where: { id: 1 }, create: { email: "a@e.com" } } } });
  void postFactory.state({ author: userRow });
  void userFactory.state({ posts: { createMany: { data: [{ title: "t" }] } } });
  void userFactory.state({ posts: postRows });
  void postFactory.create({ author: { connectOrCreate: { where: { id: 1 }, create: { email: "a@e.com" } } } });
  void userFactory.create({ posts: { createMany: { data: [{ title: "t" }] } } });
  void userFactory.create({ posts: { connect: [{ id: 1 }] } });

  // @ts-expect-error a row of a model the belongs-to relation does not point at, in a definition
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: teamRow }) });
  // @ts-expect-error an object that is neither native relation input nor a row, in a definition
  prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: bogus }) });
  // @ts-expect-error a list of rows of a model the has-many relation does not point at, in a definition
  prismaFactorio.define("user", { definition: ({ uid }) => ({ email: uid, posts: [teamRow] }) });
  // @ts-expect-error a list holding a factory, in a definition
  prismaFactorio.define("user", { definition: ({ uid }) => ({ email: uid, posts: [postFactory] }) });

  prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    // @ts-expect-error a row of a model the belongs-to relation does not point at, in a declared state
    states: { byRow: { author: teamRow } },
  });
  prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    // @ts-expect-error an object literal that is neither native relation input nor a row, in a declared state
    states: { bogus: { author: { totallyBogus: 1 } } },
  });
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: uid }),
    // @ts-expect-error a row of a model the has-many relation does not point at, in a declared state
    states: { byRow: { posts: teamRow } },
  });
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: uid }),
    // @ts-expect-error a list holding a factory, in a declared state
    states: { byFactories: { posts: [teamFactory] } },
  });

  // @ts-expect-error an object that is neither native relation input nor a row, through a state
  void postFactory.state({ author: bogus });
  // @ts-expect-error an object literal that is neither native relation input nor a row, through a state
  void postFactory.state({ author: { totallyBogus: 1 } });
  // @ts-expect-error a list of rows of a model the has-many relation does not point at, through a state
  void userFactory.state({ posts: [teamRow] });
  // @ts-expect-error a list holding a factory of the model the has-many relation points at, through a state
  void userFactory.state({ posts: [postFactory] });

  // @ts-expect-error an object that is neither native relation input nor a row, in overrides
  void postFactory.create({ author: bogus });
  // @ts-expect-error an object literal that is neither native relation input nor a row, in overrides
  void postFactory.create({ author: { totallyBogus: 1 } });
  // @ts-expect-error attributes of the parent, which name no nested create, in overrides
  void postFactory.create({ author: { email: "x@y.z", name: "X" } });
  // @ts-expect-error native relation input naming none of its keys, in overrides
  void postFactory.create({ author: {} });
  // @ts-expect-error an object that is neither native relation input nor a row, at the has-many arity
  void userFactory.create({ posts: bogus });
  // @ts-expect-error a list holding a factory of the model the has-many relation points at, in overrides
  void userFactory.create({ posts: [postFactory] });
}
