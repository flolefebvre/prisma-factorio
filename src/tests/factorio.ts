import { onTestFinished } from "vitest";
import type { FactorioOptions } from "../faker.js";
import { initPrismaFactorio, type Factorio } from "../factorio.js";
import type { EvaluationContext, Factory } from "../factory.js";
import { createTestClient, disposeTestClient, type TestClient } from "./client.js";

/**
 * A bootstrap over a throwaway database, with one factory per model already declared on it.
 *
 * `postFactory`, `commentFactory` and `membershipFactory` carry a relation default, so creating any of them walks the
 * chain of factories behind it: a comment brings a post, which brings a user, and a membership brings
 * a user and a team both.
 *
 * @example
 * ```ts
 * const { prisma, userFactory } = await factorioHarness({ seed: 7 });
 * ```
 */
export interface Harness {
  prisma: TestClient;
  prismaFactorio: Factorio<TestClient>;
  userFactory: Factory<TestClient, "user">;
  postFactory: Factory<TestClient, "post">;
  commentFactory: Factory<TestClient, "comment">;
  tagFactory: Factory<TestClient, "tag">;
  teamFactory: Factory<TestClient, "team">;
  membershipFactory: Factory<TestClient, "membership">;
}

/**
 * The definition the harness declares its user factory with.
 *
 * @example
 * ```ts
 * const userFactory = prismaFactorio.define("user", { definition: userDefinition });
 * ```
 */
export function userDefinition({ uid }: EvaluationContext): { email: string; name: string } {
  return { email: `${uid}@example.com`, name: "Ada" };
}

/**
 * Opens a test client that closes when the running test finishes.
 *
 * @example
 * ```ts
 * const prisma = await disposableClient();
 * ```
 */
export async function disposableClient(): Promise<TestClient> {
  const client = await createTestClient();
  onTestFinished(() => disposeTestClient(client));
  return client;
}

/**
 * Bootstraps the factory API over a database of its own.
 *
 * @example
 * ```ts
 * const { userFactory } = await factorioHarness();
 * const ada = await userFactory.create({ name: "Ada" });
 * ```
 */
export async function factorioHarness(options: FactorioOptions = {}): Promise<Harness> {
  const prisma = await disposableClient();
  const prismaFactorio = initPrismaFactorio(prisma, options);
  const userFactory = prismaFactorio.define("user", { definition: userDefinition });
  const postFactory = prismaFactorio.define("post", { definition: ({ uid }) => ({ title: uid, author: userFactory }) });
  const commentFactory = prismaFactorio.define("comment", {
    definition: ({ uid }) => ({ body: uid, post: postFactory }),
  });
  const tagFactory = prismaFactorio.define("tag", { definition: ({ uid }) => ({ label: uid }) });
  const teamFactory = prismaFactorio.define("team", { definition: ({ uid }) => ({ slug: uid }) });
  // Both legs of a join model are required, so its definition names a parent for each. A `has()` or a
  // `for()` layer replaces the leg it selects before anything is evaluated, leaving the factory named
  // here uncreated.
  const membershipFactory = prismaFactorio.define("membership", {
    definition: () => ({ role: "member", user: userFactory, team: teamFactory }),
  });

  return {
    prisma,
    prismaFactorio,
    userFactory,
    postFactory,
    commentFactory,
    tagFactory,
    teamFactory,
    membershipFactory,
  };
}
