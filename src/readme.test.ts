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
  users: Factory<TestClient, "user">;
  posts: Factory<TestClient, "post">;
}

// README "Usage", the `factories.ts` block: one bootstrap over a thunk, then a factory per model.
export function factoriesModule(prisma: TestClient): ReadmeFactories {
  const f = initPrismaFactorio(() => prisma, { seed: 1234, locale: "en" });

  const users = f.define("user", {
    definition: ({ faker, uid }) => ({
      email: `user-${uid}@example.com`,
      name: faker.person.fullName(),
    }),
  });

  const posts = f.define("post", {
    definition: ({ faker, index, uid }) => ({
      title: `${faker.lorem.words(3)} #${String(index)}`,
      author: { create: { email: `author-${uid}@example.com` } },
    }),
  });

  return { users, posts };
}

// README "Usage", the second block, and the bullet under it reading "`create()` returns the real row,
// or an array of rows when the factory carries a `count`" — which is what the row comment on the
// first line of that block shows.
export async function usageCreates(prisma: TestClient, { users, posts }: ReadmeFactories): Promise<void> {
  const ada = await users.create({ name: "Ada Lovelace" });
  const team = await users.count(3).create();

  expectTypeOf(ada).toEqualTypeOf<Row<TestClient, "user">>();
  expectTypeOf(team).toEqualTypeOf<Row<TestClient, "user">[]>();

  void prisma.$transaction((tx) => posts.using(tx).count(2).create());
}

// README "Usage", the bullet reading "`initPrismaFactorio` takes a client instance or a thunk", and
// the two options the Evaluation-context section's neighbouring bullets describe.
export function bootstrapForms(prisma: TestClient, options: FactorioOptions): void {
  void initPrismaFactorio(prisma);
  void initPrismaFactorio(prisma, options);
}

// README "States", the block declaring `suspended` and `vip`, the three call forms under it, and the
// bullet claiming every `states` key becomes a typed method while a misspelt one is a compile error.
export function statesSection(f: Factorio<TestClient>): void {
  const users = f.define("user", {
    definition: ({ faker, uid }) => ({
      email: `user-${uid}@example.com`,
      name: faker.person.fullName(),
    }),
    states: {
      suspended: { name: null },
      vip: ({ attrs, uid }) => ({ email: `vip-${uid}@example.com`, name: `${attrs.name ?? "anonymous"} (VIP)` }),
    },
  });

  void users.suspended().create();
  void users.count(3).vip().create();
  void users.state({ name: "Ada Lovelace" }).create();

  // Read rather than called: a call on a member the compiler could not resolve is unsafe, and the
  // member is where the error the README claims already lands.
  // @ts-expect-error a state the config never declared
  void users.suspnded;
  // @ts-expect-error a state named after a method the factory already answers to
  f.define("user", { definition: userDefinition, states: { create: { name: "Ada" } } });
  // @ts-expect-error a state named `then`, which would leave the factory thenable
  f.define("user", { definition: userDefinition, states: { then: { name: "Ada" } } });
}

// README "Relations", the first block: `for()` takes a factory of the parent model or a row of it.
export async function relationsFor({ users, posts }: ReadmeFactories): Promise<void> {
  void posts.for(users, "author").create();

  const ada = await users.create({ name: "Ada Lovelace" });
  void posts.for(ada, "author").create();
}

// README "Relations", the block under "A relation field also takes a parent directly", then the
// Ordering and Batch-cadence blocks that call the states it declares, and the bullet claiming states
// survive `for()` in both chaining directions.
export async function relationDefaults(
  f: Factorio<TestClient>,
  users: Factory<TestClient, "user">,
  ada: Row<TestClient, "user">,
): Promise<void> {
  const guests = f.define("user", {
    definition: ({ uid }) => ({ email: `guest-${uid}@example.com` }),
  });

  const posts = f.define("post", {
    definition: ({ faker, index }) => ({ title: `${faker.lorem.words(3)} #${String(index)}`, author: users }),
    states: { byGuest: { author: guests }, drafted: { title: "draft" } },
  });

  await posts.create({ author: ada });

  await posts.byGuest().for(users, "author").create();
  await posts.for(users, "author").byGuest().create();

  void posts.for(users, "author").drafted();
  void posts.drafted().for(users, "author");

  await posts.count(3).for(users, "author").create();
  await posts.count(3).create();
}

// README "Relations", the block under "A field holding many records takes a value too", and the
// bullet claiming a batch of no children writes nothing.
export async function toManyValues({ users, posts }: ReadmeFactories): Promise<void> {
  await users.create({ posts: posts.count(2) });

  const draft = await posts.create();
  await users.create({ posts: [draft] });

  await users.create({ posts: [] });
  await users.create({ posts: posts.count(0) });
}

// README "Children", the `has()` block, the Batch-cadence block below it, and the bullets naming the
// `inverse` escape hatch and the two empty forms.
export async function childrenSection({ users, posts }: ReadmeFactories): Promise<void> {
  const author = await users.has(posts.count(3), "posts").create();
  expectTypeOf(author).toEqualTypeOf<Row<TestClient, "user">>();

  void users.has(posts, "posts", { inverse: "author" });
  void users.has(posts.count(0), "posts");
  void users.has([], "posts");

  await users.count(3).has(posts.count(2), "posts").create();
  await posts.count(3).for(users, "author").create();
}

// README "Children", the block under "Narrowing `parent`": the guard is two conditions because
// `parent` is `undefined` for a record no layer brought one for, and `id` is a column only some
// models declare.
export async function narrowingParent(f: Factorio<TestClient>, users: Factory<TestClient, "user">): Promise<void> {
  const credited = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users }),
    states: {
      credited: ({ parent }) => ({
        title: parent !== undefined && "id" in parent ? `by ${String(parent.id)}` : "unattributed",
      }),
    },
  });

  await users.has(credited.credited(), "posts").create();
}

// README "Many-to-many", the implicit block, its cadence bullet, and the bullet reading "`for()` is a
// compile error at both ends, and that is correct".
export async function implicitManyToMany(
  posts: Factory<TestClient, "post">,
  tags: Factory<TestClient, "tag">,
  existingTags: Row<TestClient, "tag">[],
): Promise<void> {
  await posts.has(tags.count(3)).create();
  await tags.has(posts.count(2)).create();
  await posts.has(existingTags).create();

  await posts.count(3).has(tags.count(2)).create();

  // @ts-expect-error both sides hold many records, so the pair has no belongs-to side to name
  void posts.for(tags);
  // @ts-expect-error the same pair read from the other end
  void tags.for(posts);
}

// README "Many-to-many", the explicit block and the bullets under it: the relation field may be left
// out, `for()` works on the join model's own legs, an existing row pins one, and a definition leaving
// a leg out does not compile.
export async function explicitManyToMany(
  f: Factorio<TestClient>,
  users: Factory<TestClient, "user">,
  teams: Factory<TestClient, "team">,
  ada: Row<TestClient, "user">,
  team: Row<TestClient, "team">,
): Promise<void> {
  const memberships = f.define("membership", { definition: () => ({ role: "member", user: users, team: teams }) });

  await users.has(memberships.count(2).state({ role: "admin" }), "memberships").create();

  void users.has(memberships.count(2));
  void memberships.count(2).for(ada);
  void memberships.state({ team });

  // @ts-expect-error both legs of a join model are required, so a definition naming one does not compile
  f.define("membership", { definition: () => ({ role: "member", user: users }) });
}

// README "Recycle", the block declaring `posts` and `comments` with two user legs, the Children block
// below it, and the bullets: the pool never stands in for the record asked for, successive calls merge
// per model, and a row loaded with `include` is accepted where one missing a required scalar is not.
export async function recycleSection(
  f: Factorio<TestClient>,
  users: Factory<TestClient, "user">,
  ada: Row<TestClient, "user">,
  grace: Row<TestClient, "user">,
  loaded: Row<TestClient, "user"> & { posts: Row<TestClient, "post">[] },
  existingPosts: Row<TestClient, "post">[],
  onePost: Row<TestClient, "post">,
): Promise<void> {
  const posts = f.define("post", {
    definition: ({ uid }) => ({ title: uid, author: users, editor: users }),
  });

  const comments = f.define("comment", { definition: ({ uid }) => ({ body: uid, post: posts }) });

  const comment = await comments.recycle("user", ada).create();
  expectTypeOf(comment).toEqualTypeOf<Row<TestClient, "comment">>();

  void comments.recycle("comment", comment);
  void comments.recycle("user", ada).recycle("user", grace);
  void comments.recycle("user", loaded);

  await users.recycle("post", existingPosts).has(posts.count(3), "posts").create();

  // README "Recycle", the #47 bullet: the shape it names fails at runtime rather than at compile time,
  // which is why it stands here without a directive.
  void users.count(2).recycle("post", onePost).has(posts, "posts");

  // @ts-expect-error a model name the client does not carry
  void comments.recycle("usre", ada);
  // @ts-expect-error a row missing a required scalar of the model it is pooled as
  void comments.recycle("user", { id: 1 });
}

// README "Callbacks", the block declaring one callback in the config and adding a second at the call
// site, and the bullet reading "The callback receives the created row and the client the chain writes
// through".
export async function callbacksSection(f: Factorio<TestClient>): Promise<void> {
  const users = f.define("user", {
    definition: ({ faker, uid }) => ({ email: `user-${uid}@example.com`, name: faker.person.fullName() }),
    afterCreating: async (user, { client }) => {
      await client.post.create({ data: { title: "Welcome", author: { connect: { id: user.id } } } });
    },
  });

  await users
    .afterCreating(async (user, { client }) => {
      await client.post.create({ data: { title: "Second", author: { connect: { id: user.id } } } });
    })
    .create();
}

// README "Seeding", the `seed.ts` block. Its `posts` and `comments` are the ones Recycle declares, so
// each of the fifty posts fills two user legs from the pool: the arithmetic the prose gives holds only
// for that pair of definitions.
export async function seedScript(
  prisma: TestClient,
  users: Factory<TestClient, "user">,
  posts: Factory<TestClient, "post">,
  comments: Factory<TestClient, "comment">,
): Promise<void> {
  const authors = await users.count(5).create();

  await posts.count(50).recycle("user", authors).has(comments.count(2), "comments").create();

  await prisma.$disconnect();
}

// README "Deviations from Laravel", the block replacing Laravel's `sequence()` with a state closure
// reading `index`.
export async function withoutSequence(users: Factory<TestClient, "user">): Promise<void> {
  await users
    .count(10)
    .state(({ index }) => ({ name: index % 2 === 0 ? "Ada" : "Grace" }))
    .create();
}

// README "Good to know", the bullet "An explicit `id` and a belongs-to relation field cannot meet".
// Prisma's checked create input carries no `id`, so naming one forces the record into the unchecked
// branch, which drops every relation field whose foreign key the model holds and demands the raw
// column instead. A Prisma release reshaping either branch falsifies the bullet, and these three
// lines are what says so.
export function explicitIdAndRelation(posts: Factory<TestClient, "post">): void {
  void posts.create({ id: 7 });
  void posts.create({ id: 7, authorId: 1 });

  // @ts-expect-error no branch of the create input survives an id beside a belongs-to relation field
  void posts.create({ id: 7, author: { connect: { id: 1 } } });
}

// README "Good to know", the bullet "A wrong-model row in a relation attribute is not caught". The
// seven calls without a directive are that hole: they compile, and a directive on any of them would
// fail this gate until the hole is closed (#48). A row rides through at both arities and by every route
// an attribute is reached by; a factory rides through inside a list alone. What the bullet says *is*
// caught follows them, and what a row that compiles then does to the database is pinned in
// `factory.test.ts`.
export function wrongModelValues(
  users: Factory<TestClient, "user">,
  posts: Factory<TestClient, "post">,
  teams: Factory<TestClient, "team">,
  teamRow: Row<TestClient, "team">,
): void {
  void posts.create({ author: teamRow });
  void users.create({ posts: teamRow });
  void users.create({ posts: [teamRow] });
  void posts.state({ author: teamRow });
  void users.create({ posts: [teams] });
  void users.create({ posts: [teams.count(2)] });
  void users.state({ posts: [teams] });

  // @ts-expect-error no belongs-to relation from "post" to "team"
  void posts.for(teamRow, "author");
  // @ts-expect-error no has-many relation from "user" to "team"
  void users.has(teamRow, "posts");
  // @ts-expect-error a factory of a model the belongs-to relation does not point at
  void posts.create({ author: teams });
  // @ts-expect-error a factory of a model the has-many relation does not point at
  void users.create({ posts: teams });
  // @ts-expect-error a factory of a model the belongs-to relation does not point at, through a state
  void posts.state({ author: teams });
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
  const { prisma, posts, users } = await factorioHarness();

  await expect(
    prisma.$transaction(async (tx) => {
      const ada = await users.using(tx).has(posts.count(2), "posts").create();

      const written = await tx.post.findMany({ where: { authorId: ada.id } });
      expect(written).toHaveLength(2);

      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
});
