import { expect, expectTypeOf, test } from "vitest";
import {
  initPrismaFactorio,
  type CreateInput,
  type Factorio,
  type FactorioOptions,
  type Factory,
  type Overrides,
  type PartialAttributes,
  type Row,
} from "./index.js";
import type { TestClient } from "./tests/client.js";
import { factorioHarness, userDefinition } from "./tests/factorio.js";

// README.md, compiled. Prettier gates the syntax of the document's fenced `ts` blocks and nothing
// gates their types, so a Prisma release or a change to this API would falsify the document in
// silence. Each function below mirrors one block, named after the section it comes from, and every
// `@ts-expect-error` pins a claim the prose makes about what the compiler refuses.
//
// The document's imports map onto this repository: `"@flefebvre/prisma-factorio"` is `"./index.js"` and `./db.js`
// is the test harness's client. A block's module-scope `export const` declarations are locals of the
// function that mirrors it, and a declaration a later block leans on is that function's parameter.
//
// Never invoked, save for the test at the foot of the file: these calls exist for `pnpm typecheck`,
// which reads this file. Each directive fails the gate the moment the type it names stops rejecting —
// or stops accepting — what it is given.

interface ReadmeFactories {
  userFactory: Factory<TestClient, "user">;
  postFactory: Factory<TestClient, "post">;
}

// README "Usage", the `factories.ts` block: one bootstrap over a thunk, then a factory per model.
export function factoriesModule(prisma: TestClient): ReadmeFactories {
  const prismaFactorio = initPrismaFactorio(() => prisma, { seed: 1234, locale: "en" });

  const userFactory = prismaFactorio.define("user", {
    definition: ({ faker, uid }) => ({
      email: `user-${uid}@example.com`,
      name: faker.person.fullName(),
    }),
  });

  const postFactory = prismaFactorio.define("post", {
    definition: ({ faker, index, uid }) => ({
      title: `${faker.lorem.words(3)} #${String(index)}`,
      author: { create: { email: `author-${uid}@example.com` } },
    }),
  });

  return { userFactory, postFactory };
}

// README "Usage", the second block, and the bullet under it reading "`create()` returns the real row,
// or an array of rows when the factory carries a `count`" — which is what the row comment on the
// first line of that block shows.
export async function usageCreates(prisma: TestClient, { userFactory, postFactory }: ReadmeFactories): Promise<void> {
  const ada = await userFactory.create({ name: "Ada Lovelace" });
  const team = await userFactory.count(3).create();

  expectTypeOf(ada).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(team).toEqualTypeOf<Row<TestClient, "user">[]>();

  void prisma.$transaction((tx) => postFactory.using(tx).count(2).create());
}

// README "Usage", the bullet reading "`initPrismaFactorio` takes a client instance or a thunk", and
// the two options the Evaluation-context section's neighbouring bullets describe.
export function bootstrapForms(prisma: TestClient, options: FactorioOptions): void {
  void initPrismaFactorio(prisma);
  void initPrismaFactorio(prisma, options);
}

// README "States", the block declaring `suspended` and `vip`, the three call forms under it, and the
// bullet claiming every `states` key becomes a typed method while a misspelt one is a compile error.
export function statesSection(prismaFactorio: Factorio<TestClient>): void {
  const userFactory = prismaFactorio.define("user", {
    definition: ({ faker, uid }) => ({
      email: `user-${uid}@example.com`,
      name: faker.person.fullName(),
    }),
    states: {
      suspended: { name: null },
      vip: ({ attrs, uid }) => ({ email: `vip-${uid}@example.com`, name: `${attrs.name ?? "anonymous"} (VIP)` }),
    },
  });

  void userFactory.suspended().create();
  void userFactory.count(3).vip().create();
  void userFactory.state({ name: "Ada Lovelace" }).create();

  // Read rather than called: a call on a member the compiler could not resolve is unsafe, and the
  // member is where the error the README claims already lands.
  // @ts-expect-error a state the config never declared
  void userFactory.suspnded;
  // @ts-expect-error a state named after a method the factory already answers to
  prismaFactorio.define("user", { definition: userDefinition, states: { create: { name: "Ada" } } });
  // @ts-expect-error a state named `then`, which would leave the factory thenable
  prismaFactorio.define("user", { definition: userDefinition, states: { then: { name: "Ada" } } });
}

// README "Relations", the first block: `for()` takes a factory of the parent model or a row of it.
export async function relationsFor({ userFactory, postFactory }: ReadmeFactories): Promise<void> {
  void postFactory.for(userFactory, "author").create();

  const ada = await userFactory.create({ name: "Ada Lovelace" });
  void postFactory.for(ada, "author").create();
}

// README "Relations", the block under "A relation field also takes a parent directly", then the
// Ordering and Batch-cadence blocks that call the states it declares, and the bullet claiming states
// survive `for()` in both chaining directions.
export async function relationDefaults(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  ada: Row<TestClient, "user">,
): Promise<void> {
  const guestFactory = prismaFactorio.define("user", {
    definition: ({ uid }) => ({ email: `guest-${uid}@example.com` }),
  });

  const postFactory = prismaFactorio.define("post", {
    definition: ({ faker, index }) => ({ title: `${faker.lorem.words(3)} #${String(index)}`, author: userFactory }),
    states: { byGuest: { author: guestFactory }, drafted: { title: "draft" } },
  });

  await postFactory.create({ author: ada });

  await postFactory.byGuest().for(userFactory, "author").create();
  await postFactory.for(userFactory, "author").byGuest().create();

  void postFactory.for(userFactory, "author").drafted();
  void postFactory.drafted().for(userFactory, "author");

  await postFactory.count(3).for(userFactory, "author").create();
  await postFactory.count(3).create();
}

// README "Relations", the block under "A field holding many records takes a value too", and the
// bullet claiming a batch of no children writes nothing.
export async function toManyValues({ userFactory, postFactory }: ReadmeFactories): Promise<void> {
  await userFactory.create({ posts: postFactory.count(2) });

  const draft = await postFactory.create();
  await userFactory.create({ posts: [draft] });

  await userFactory.create({ posts: [] });
  await userFactory.create({ posts: postFactory.count(0) });
}

// README "Children", the `has()` block, the Batch-cadence block below it, and the bullets naming the
// `inverse` escape hatch and the two empty forms.
export async function childrenSection({ userFactory, postFactory }: ReadmeFactories): Promise<void> {
  const author = await userFactory.has(postFactory.count(3), "posts").create();
  expectTypeOf(author).toEqualTypeOf<Row<TestClient, "user">>();

  void userFactory.has(postFactory, "posts", { inverse: "author" });
  void userFactory.has(postFactory.count(0), "posts");
  void userFactory.has([], "posts");

  await userFactory.count(3).has(postFactory.count(2), "posts").create();
  await postFactory.count(3).for(userFactory, "author").create();
}

// README "Children", the block under "Narrowing `parent`": the guard is two conditions because
// `parent` is `undefined` for a record no layer brought one for, and `id` is a column only some
// models declare.
export async function narrowingParent(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
): Promise<void> {
  const creditedFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory }),
    states: {
      credited: ({ parent }) => ({
        title: parent !== undefined && "id" in parent ? `by ${String(parent.id)}` : "unattributed",
      }),
    },
  });

  await userFactory.has(creditedFactory.credited(), "posts").create();
}

// README "Many-to-many", the implicit block, its cadence bullet, and the bullet reading "`for()` is a
// compile error at both ends, and that is correct".
export async function implicitManyToMany(
  postFactory: Factory<TestClient, "post">,
  tagFactory: Factory<TestClient, "tag">,
  existingTags: Row<TestClient, "tag">[],
): Promise<void> {
  await postFactory.has(tagFactory.count(3)).create();
  await tagFactory.has(postFactory.count(2)).create();
  await postFactory.has(existingTags).create();

  await postFactory.count(3).has(tagFactory.count(2)).create();

  // @ts-expect-error both sides hold many records, so the pair has no belongs-to side to name
  void postFactory.for(tagFactory);
  // @ts-expect-error the same pair read from the other end
  void tagFactory.for(postFactory);
}

// README "Many-to-many", the explicit block and the bullets under it: the relation field may be left
// out, `for()` works on the join model's own legs, an existing row pins one, and a definition leaving
// a leg out does not compile.
export async function explicitManyToMany(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  teamFactory: Factory<TestClient, "team">,
  ada: Row<TestClient, "user">,
  team: Row<TestClient, "team">,
): Promise<void> {
  const membershipFactory = prismaFactorio.define("membership", {
    definition: () => ({ role: "member", user: userFactory, team: teamFactory }),
  });

  await userFactory.has(membershipFactory.count(2).state({ role: "admin" }), "memberships").create();

  void userFactory.has(membershipFactory.count(2));
  void membershipFactory.count(2).for(ada);
  void membershipFactory.state({ team });

  // @ts-expect-error both legs of a join model are required, so a definition naming one does not compile
  prismaFactorio.define("membership", { definition: () => ({ role: "member", user: userFactory }) });
}

// README "Recycle", the opening blocks: a `bookingFactory` whose `venue` and `customer` defaults each bring
// a venue of their own, and the recipe recycling one venue into both legs. The `Booking` model the
// section shows is the scratch schema's own.
export async function recycleSharedParentSection(
  prismaFactorio: Factorio<TestClient>,
  venueFactory: Factory<TestClient, "venue">,
  customerFactory: Factory<TestClient, "customer">,
): Promise<void> {
  const bookingFactory = prismaFactorio.define("booking", {
    definition: ({ uid }) => ({ seat: uid, venue: venueFactory, customer: customerFactory }),
  });

  const venue = await venueFactory.create();
  const booking = await bookingFactory.recycle("venue", venue).create();
  expectTypeOf(booking).toEqualTypeOf<Row<TestClient, "booking">>();
}

// README "Recycle", the block declaring `postFactory` and `commentFactory` with two user legs, the Children block
// below it, and the bullets: the pool never stands in for the record asked for, successive calls merge
// per model, and a row loaded with `include` is accepted where one missing a required scalar is not.
export async function recycleSection(
  prismaFactorio: Factorio<TestClient>,
  userFactory: Factory<TestClient, "user">,
  ada: Row<TestClient, "user">,
  grace: Row<TestClient, "user">,
  loaded: Row<TestClient, "user"> & { posts: Row<TestClient, "post">[] },
  existingPosts: Row<TestClient, "post">[],
  onePost: Row<TestClient, "post">,
): Promise<void> {
  /* jscpd:ignore-start — a transcription of the document restates what the suite declares; that is this file's purpose, not duplication to refactor away. */
  const postFactory = prismaFactorio.define("post", {
    definition: ({ uid }) => ({ title: uid, author: userFactory, editor: userFactory }),
  });

  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
  });
  /* jscpd:ignore-end */

  const comment = await commentFactory.recycle("user", ada).create();
  expectTypeOf(comment).toEqualTypeOf<Row<TestClient, "comment">>();

  void commentFactory.recycle("comment", comment);
  void commentFactory.recycle("user", ada).recycle("user", grace);
  void commentFactory.recycle("user", loaded);

  await userFactory.recycle("post", existingPosts).has(postFactory.count(3), "posts").create();

  // README "Recycle", the #47 bullet: the shape it names fails at runtime rather than at compile time,
  // which is why it stands here without a directive.
  void userFactory.count(2).recycle("post", onePost).has(postFactory, "posts");

  // @ts-expect-error a model name the client does not carry
  void commentFactory.recycle("usre", ada);
  // @ts-expect-error a row missing a required scalar of the model it is pooled as
  void commentFactory.recycle("user", { id: 1 });
}

// README "Callbacks", the block declaring one callback in the config and adding a second at the call
// site, and the bullet reading "The callback receives the created row and the client the chain writes
// through".
export async function callbacksSection(prismaFactorio: Factorio<TestClient>): Promise<void> {
  const userFactory = prismaFactorio.define("user", {
    definition: ({ faker, uid }) => ({ email: `user-${uid}@example.com`, name: faker.person.fullName() }),
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "Welcome", author: { connect: { id: user.id } } } });
    },
  });

  await userFactory
    .afterCreating(async (user, { client }) => {
      await client.post.create({ data: { title: "Second", author: { connect: { id: user.id } } } });
    })
    .create();
}

// README "Seeding", the `seed.ts` block. Its `postFactory` and `commentFactory` are the ones Recycle declares, so
// each of the fifty posts fills two user legs from the pool: the arithmetic the prose gives holds only
// for that pair of definitions.
export async function seedScript(
  prisma: TestClient,
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  commentFactory: Factory<TestClient, "comment">,
): Promise<void> {
  const authors = await userFactory.count(5).create();

  await postFactory.count(50).recycle("user", authors).has(commentFactory.count(2), "comments").create();

  await prisma.$disconnect();
}

// README "Deviations from Laravel", the block replacing Laravel's `sequence()` with a state closure
// reading `index`.
export async function withoutSequence(userFactory: Factory<TestClient, "user">): Promise<void> {
  await userFactory
    .count(10)
    .state(({ index }) => ({ name: index % 2 === 0 ? "Ada" : "Grace" }))
    .create();
}

// README "Runtime edges", the bullet "An explicit database-generated `id` meets a belongs-to relation
// field only through a parent the build creates". Prisma's checked create input carries no `id` the
// database generates, so naming one forces the record into the unchecked branch, which drops every
// relation field whose foreign key the model holds and takes the raw column instead. An id the client
// generates stays in the checked input, so on `invite` the same pairing compiles. A Prisma release
// reshaping either branch falsifies the bullet, and these lines are what says so; the runtime half is
// pinned in `factory.test.ts`.
export function explicitIdAndRelation(
  postFactory: Factory<TestClient, "post">,
  inviteFactory: Factory<TestClient, "invite">,
  teamFactory: Factory<TestClient, "team">,
  teamRow: Row<TestClient, "team">,
): void {
  void postFactory.create({ id: 7 });
  void postFactory.create({ id: 7, authorId: 1 });

  // @ts-expect-error no branch of the create input survives an id beside a belongs-to relation field
  void postFactory.create({ id: 7, author: { connect: { id: 1 } } });

  void inviteFactory.create({ id: "3f2c9e1a-0b7d-4c55-9a8e-6d1f2b3c4d5e", team: { connect: { id: 1 } } });
  void inviteFactory.create({ id: "3f2c9e1a-0b7d-4c55-9a8e-6d1f2b3c4d5e", team: teamFactory });
  void inviteFactory.create({ id: "3f2c9e1a-0b7d-4c55-9a8e-6d1f2b3c4d5e", team: teamRow });
}

// README "Typing edges", the bullet "Error shape": a misspelled field is reported on the offending
// property against a type naming it, so each directive sits on that property's line rather than on
// the call's. A declared field of the wrong type still reads `never`.
test("a field the model does not declare reads as a type naming the field and the model", () => {
  expectTypeOf<Overrides<TestClient, "user", { nmae: string }>["nmae"]>().toEqualTypeOf<{
    'ERROR: "nmae" is not a field of "user"': true;
  }>();
});

export function errorShape(prismaFactorio: Factorio<TestClient>, userFactory: Factory<TestClient, "user">): void {
  void userFactory.create({
    // @ts-expect-error a misspelled field in overrides
    nmae: "Ada",
  });
  void userFactory.state({
    // @ts-expect-error a misspelled field in a state
    nmae: "Ada",
  });
  prismaFactorio.define("user", {
    definition: ({ uid }) => ({
      email: `${uid}@example.com`,
      // @ts-expect-error a misspelled field in a definition
      nmae: "Ada",
    }),
  });
  void userFactory.create({
    // @ts-expect-error a declared field of the wrong type
    name: 1,
  });
  // @ts-expect-error a numeric key the model does not declare, reported on the call
  void userFactory.create({ 1: "Ada" });
}

// README "Relations", the paragraph "Such a value is a factory, an existing row, or Prisma's own
// relation input": every value a relation field takes is checked against the model it points at, at
// both arities and by every route an attribute is reached by, and relation input naming none of its
// keys stands for nothing. The `for()` and `has()` calls pin the bullet "The relation field is checked
// against the pair of models".
export function wrongModelValues(
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  teamFactory: Factory<TestClient, "team">,
  teamRow: Row<TestClient, "team">,
  commentFactory: Factory<TestClient, "comment">,
): void {
  // @ts-expect-error a row of a model the belongs-to relation does not point at
  void postFactory.create({ author: teamRow });
  // @ts-expect-error a row of a model the has-many relation does not point at
  void userFactory.create({ posts: teamRow });
  // @ts-expect-error a list of rows of a model the has-many relation does not point at
  void userFactory.create({ posts: [teamRow] });
  // @ts-expect-error a row of a model the belongs-to relation does not point at, through a state
  void postFactory.state({ author: teamRow });
  // @ts-expect-error a list holding a factory, which stands for no row
  void userFactory.create({ posts: [teamFactory] });
  // @ts-expect-error a list holding a batched factory, which stands for no row either
  void userFactory.create({ posts: [teamFactory.count(2)] });
  // @ts-expect-error a list holding a factory, through a state
  void userFactory.state({ posts: [teamFactory] });
  // @ts-expect-error a row-shaped object names no key of the relation input
  void postFactory.create({ author: { email: "x@y.z", name: "X" } });
  // @ts-expect-error an empty relation input names none of its keys
  void postFactory.create({ author: {} });

  // @ts-expect-error no belongs-to relation from "post" to "team", named on the field
  void postFactory.for(teamRow, "author");
  // @ts-expect-error a hand-built partial object is no row
  void postFactory.for({ id: 1 }, "author");
  // @ts-expect-error no belongs-to relation from "comment" to "user"
  void commentFactory.for(userFactory);
  // @ts-expect-error no has-many relation from "user" to "team", named on the field
  void userFactory.has(teamRow, "posts");
  // @ts-expect-error the pair shares several has-many relations
  void userFactory.has(postFactory);

  // The messages the bullets quote, read off the methods themselves: a field slot typed as a message
  // takes that message.
  void postFactory.for(teamRow, 'ERROR: no belongs-to relation from "post" to "team"');
  void postFactory.for(
    { id: 1 },
    "ERROR: the parent is neither a factory of one record nor a full row of any model; a partial object is not a row",
  );
  void userFactory.has(teamRow, 'ERROR: no has-many relation from "user" to "team"');
  // @ts-expect-error a factory of a model the belongs-to relation does not point at
  void postFactory.create({ author: teamFactory });
  // @ts-expect-error a factory of a model the has-many relation does not point at
  void userFactory.create({ posts: teamFactory });
  // @ts-expect-error a factory of a model the belongs-to relation does not point at, through a state
  void postFactory.state({ author: teamFactory });
}

// Held rather than written at the call site: a fresh object literal would be measured by excess
// property checking rather than by the exported type this pins.
declare const created: CreateInput<TestClient, "user">;

// README "Good to know", the bullet "`CreateInput` is no longer a Prisma alias": its relation keys
// additionally accept a factory, a row and a list of rows, so a value typed through this package's
// export no longer satisfies Prisma's own `create` data argument.
export function createInputIsNotPrismas(prisma: TestClient): void {
  // @ts-expect-error the widened relation keys leave no branch of Prisma's input assignable
  void prisma.user.create({ data: created });
}

// README "Types", the `helpers.ts` and `posts.test.ts` blocks and the bullets under them: each exported
// type in the role the bullet gives it, a `satisfies`-checked value forwarding like a literal, the
// excess-key check surviving the generic helper, and `Parameters<>` spelling out `PartialAttributes`.
export async function typesSection({ userFactory, postFactory }: ReadmeFactories): Promise<void> {
  async function makeAuthors(): Promise<Row<TestClient, "user">[]> {
    return userFactory.count(3).create();
  }

  async function makePost<O>(overrides?: Overrides<TestClient, "post", O>): Promise<Row<TestClient, "post">> {
    return postFactory.create(overrides);
  }

  const drafted = { title: "Draft" } satisfies PartialAttributes<TestClient, "post">;

  const draft = await makePost(drafted);

  expectTypeOf(draft).toEqualTypeOf<Row<TestClient, "post">>();
  expectTypeOf(draft).toEqualTypeOf<Awaited<ReturnType<typeof postFactory.create>>>();
  expectTypeOf(userFactory.count(3).create()).resolves.toEqualTypeOf<Row<TestClient, "user">[]>();
  void makeAuthors();
  void makePost();

  // @ts-expect-error a field the model never declares, through the generic helper
  void makePost({ titel: "Draft" });

  type ViaParameters = Parameters<typeof postFactory.create>[0];
  const viaParameters: ViaParameters = { title: "Draft" };
  void viaParameters;
  expectTypeOf<ViaParameters>().toExtend<PartialAttributes<TestClient, "post"> | undefined>();
  expectTypeOf<PartialAttributes<TestClient, "post"> | undefined>().toExtend<ViaParameters>();
}

// README "Types", the `PartialAttributes` bullet: a value annotated with that type, rather than
// checked with `satisfies`, is a union of the create input's branches, and reaches `create()` and
// `state()` as it is.
export function partialAttributesForwarding(
  postFactory: Factory<TestClient, "post">,
  attrs: PartialAttributes<TestClient, "post">,
): void {
  expectTypeOf(postFactory.create(attrs)).resolves.toEqualTypeOf<Row<TestClient, "post">>();
  expectTypeOf(postFactory.state(attrs)).toEqualTypeOf<Factory<TestClient, "post">>();
}

// README "Transactional tests", the `posts.test.ts` block — run rather than merely compiled, the
// recipe being the one the section tells a reader to copy. The sentinel is what commits nothing.
class Rollback extends Error {}

test("an author reaches the posts written for them", async () => {
  const { prisma, postFactory, userFactory } = await factorioHarness();

  await expect(
    prisma.$transaction(async (tx) => {
      const ada = await userFactory.using(tx).has(postFactory.count(2), "posts").create();

      const written = await tx.post.findMany({ where: { authorId: ada.id } });
      expect(written).toHaveLength(2);

      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
});
