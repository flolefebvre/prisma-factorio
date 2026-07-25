import { defineFactory } from "../lib/index.ts";
import { postFactory, tagFactory, teamFactory, userFactory } from "./factories.ts";
import { prisma } from "./support.ts";
import type { User, Post } from "../generated/prisma/client.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/* --- return types flip with count() --- */
const one: Promise<User> = userFactory.create();
const many: Promise<User[]> = userFactory.count(3).create();
const stillMany: Promise<User[]> = userFactory.count(3).admin().create();
const exactlyUser: Exact<Awaited<ReturnType<typeof userFactory.create>>, User> = true;

/* --- @ts-expect-error: count() result is an array, not a single model --- */
// @ts-expect-error count(3) returns User[]
const wrongCard: Promise<User> = userFactory.count(3).create();

/* --- states are typed and chainable --- */
const chained: Promise<Post[]> = postFactory.count(2).published().create();
// @ts-expect-error 'suspended' was never declared as a state
userFactory.suspended();
// @ts-expect-error the 'named' state takes a string
userFactory.named(42);

/* --- definitions are checked against Prisma's create input --- */
defineFactory(prisma, "user", {
  // @ts-expect-error 'nickname' is not a field of User
  define: () => ({ email: "a@b.c", name: "n", nickname: "x" }),
});
defineFactory(prisma, "user", {
  // @ts-expect-error email must be a string
  define: () => ({ email: 42 }),
});
// @ts-expect-error 'invoice' is not a model on this client
defineFactory(prisma, "invoice", { define: () => ({}) });

/* --- overrides are checked --- */
userFactory.create({ name: "ok" });
// @ts-expect-error 'name' must be a string
userFactory.create({ name: 42 });
// @ts-expect-error 'nope' is not a field of User
userFactory.create({ nope: true });

/* --- relations: field name must be a real relation --- */
userFactory.with("posts", postFactory.count(2));
// @ts-expect-error 'email' is a scalar, not a relation
userFactory.with("email", postFactory);
// @ts-expect-error 'nope' is not a field at all
userFactory.with("nope", postFactory);

/* --- relations: the factory must target the right model --- */
// @ts-expect-error a Team factory cannot satisfy User.posts
userFactory.with("posts", teamFactory);

/* --- raw nested writes remain fully typed --- */
postFactory.with("author", { connect: { id: 1 } });
// @ts-expect-error 'nope' is not a unique field of User
postFactory.with("author", { connect: { nope: 1 } });

/* --- make() returns the create input, not a persisted row --- */
const made = userFactory.make();
const madeEmail: string | undefined = made.email;
// @ts-expect-error 'createdAt' is a Date on the input, never a number
const madeBad: number | undefined = made.createdAt;

export { one, many, stillMany, exactlyUser, wrongCard, chained, made, madeEmail, madeBad, tagFactory };
