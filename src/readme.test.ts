import { expect, expectTypeOf, test } from "vitest";
import {
  initPrismaFactorio,
  type CreateInput,
  type Factorio,
  type FactorioOptions,
  type Factory,
  type Row,
} from "./index.js";
import type { TestClient } from "./tests/client.js";
import { factorioHarness, userDefinition } from "./tests/factorio.js";

// README.md, compiled. Prettier gates the syntax of the document's fenced `ts` blocks and nothing
// gates their types, so a Prisma release or a change to this API would falsify the document in
// silence. Each function below mirrors one block, named after the section it comes from, and every
// `@ts-expect-error` pins a claim the prose makes about what the compiler refuses.
//
// The document's imports map onto this repository: `"prisma-factorio"` is `"./index.js"` and `./db.js`
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

// README "Good to know", the bullet "An explicit `id` and a belongs-to relation field cannot meet".
// Prisma's checked create input carries no `id`, so naming one forces the record into the unchecked
// branch, which drops every relation field whose foreign key the model holds and demands the raw
// column instead. A Prisma release reshaping either branch falsifies the bullet, and these three
// lines are what says so.
export function explicitIdAndRelation(postFactory: Factory<TestClient, "post">): void {
  void postFactory.create({ id: 7 });
  void postFactory.create({ id: 7, authorId: 1 });

  // @ts-expect-error no branch of the create input survives an id beside a belongs-to relation field
  void postFactory.create({ id: 7, author: { connect: { id: 1 } } });
}

// README "Good to know", the bullet "A wrong-model row in a relation attribute is not caught". The
// seven calls without a directive are that hole: they compile, and a directive on any of them would
// fail this gate until the hole is closed (#48). A row rides through at both arities and by every route
// an attribute is reached by; a factory rides through inside a list alone. What the bullet says *is*
// caught follows them, and what a row that compiles then does to the database is pinned in
// `factory.test.ts`.
export function wrongModelValues(
  userFactory: Factory<TestClient, "user">,
  postFactory: Factory<TestClient, "post">,
  teamFactory: Factory<TestClient, "team">,
  teamRow: Row<TestClient, "team">,
): void {
  void postFactory.create({ author: teamRow });
  void userFactory.create({ posts: teamRow });
  void userFactory.create({ posts: [teamRow] });
  void postFactory.state({ author: teamRow });
  void userFactory.create({ posts: [teamFactory] });
  void userFactory.create({ posts: [teamFactory.count(2)] });
  void userFactory.state({ posts: [teamFactory] });

  // @ts-expect-error no belongs-to relation from "post" to "team"
  void postFactory.for(teamRow, "author");
  // @ts-expect-error no has-many relation from "user" to "team"
  void userFactory.has(teamRow, "posts");
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
