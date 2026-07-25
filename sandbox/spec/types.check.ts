/**
 * Type-level acceptance tests. These never run: `tsc` is the assertion.
 * `expectTypeOf` is unusable here because it expands Prisma's `Date` columns
 * into the whole `Date` interface and then reports spurious mismatches.
 */
import { factoryScope } from "../lib/index.ts";
import type { PrismaClient, Post, Tagging, User } from "../generated/prisma/client.ts";
import type { Factories } from "./factories.ts";

declare const f: Factories;
declare const prisma: PrismaClient;
declare const someUser: User;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <_Check extends true>(): void => undefined;
type Created<T> = Awaited<T>;

/* ---------------------------------------------------------------- *
 * What `create()` resolves to
 * ---------------------------------------------------------------- */

// A bare factory yields the plain record.
same<Same<Created<ReturnType<typeof f.user.create>>, User>>();

// `count()` switches the result to an array.
same<Same<Created<ReturnType<ReturnType<typeof f.user.count>["create"]>>, User[]>>();

export const resultTypes = async (): Promise<void> => {
  // `has()` widens the result with the relation it created.
  const withPosts = await f.user.has("posts", 3).create();
  same<Same<typeof withPosts, User & { posts: Post[] }>>();

  // `for()` widens it with the parent it attached.
  const withAuthor = await f.post.for("author", someUser).create();
  same<Same<typeof withAuthor, Post & { author: User }>>();

  // Nested `has()` carries a nested include through to the result.
  const deep = await f.user.has("posts", f.post.count(2).has("taggings", 1)).create();
  same<Same<typeof deep, User & { posts: (Post & { taggings: Tagging[] })[] }>>();

  // States and `count()` do not disturb the accumulated include.
  const many = await f.user.admin().count(2).has("posts", 1).create();
  same<Same<typeof many, (User & { posts: Post[] })[]>>();

  // Relations the definition creates are not included, so they are not on the type.
  const post = await f.post.create();
  // @ts-expect-error `author` was created by the definition, not declared at the call site
  void post.author;
};

/* ---------------------------------------------------------------- *
 * What the compiler rejects
 * ---------------------------------------------------------------- */

export const rejectedCalls = (): void => {
  // @ts-expect-error `nope` is not a relation on User
  void f.user.has("nope", 1);
  // @ts-expect-error `profile` is a to-one relation, not a list
  void f.user.has("profile", 1);
  // @ts-expect-error `tags` is a list, not a to-one relation
  void f.post.for("tags", someUser);
  // @ts-expect-error a Post factory cannot fill Post's `author`
  void f.post.for("author", f.post);
  // @ts-expect-error `suspended` is not a declared state
  void f.user.suspended();
  // @ts-expect-error `role` is a string column
  void f.user.create({ role: 123 });
  // @ts-expect-error `nickname` is not a column on User
  void f.user.create({ nickname: "ada" });
  // @ts-expect-error `published` is a Post column, not a User column
  void f.user.state({ published: true });
};

export const rejectedDefinitions = (): void => {
  const { define, use } = factoryScope(prisma);

  define("user", {
    // @ts-expect-error `nickname` is not a column on User
    fields: { name: "a", email: "b", nickname: "c" },
  });
  // @ts-expect-error `name` is a string column
  define("user", { fields: { name: 42 } });
  define("user", {
    fields: { name: "a" },
    // @ts-expect-error `nickname` is not a column on User
    states: { odd: { nickname: "c" } },
  });
  // @ts-expect-error a Tag factory cannot fill Post's `author`
  define("post", { fields: { title: "t", author: use("tag") } });
  // @ts-expect-error `orders` is not a model on this client
  define("orders", { fields: {} });
};
