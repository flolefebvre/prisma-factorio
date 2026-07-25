import { onTestFinished } from "vitest";
import type { FakerOptions } from "../faker.js";
import { initPrismaFactorio, type Factorio } from "../factorio.js";
import type { EvaluationContext, Factory } from "../factory.js";
import { createTestClient, disposeTestClient, type TestClient } from "./client.js";

/**
 * A bootstrap over a throwaway database, with a user factory already declared on it.
 *
 * @example
 * ```ts
 * const { prisma, users } = await factorioHarness({ seed: 7 });
 * ```
 */
export interface Harness {
  prisma: TestClient;
  f: Factorio<TestClient>;
  users: Factory<TestClient, "user">;
}

/**
 * The definition the harness declares its user factory with.
 *
 * @example
 * ```ts
 * const users = f.define("user", { definition: userDefinition });
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
 * const { users } = await factorioHarness();
 * const ada = await users.create({ name: "Ada" });
 * ```
 */
export async function factorioHarness(options: FakerOptions = {}): Promise<Harness> {
  const prisma = await disposableClient();
  const f = initPrismaFactorio(prisma, options);

  return { prisma, f, users: f.define("user", { definition: userDefinition }) };
}
