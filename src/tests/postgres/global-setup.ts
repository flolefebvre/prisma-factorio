import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** A connection string on a role allowed to create and drop databases. */
    postgresUrl: string;
  }
}

const IMAGE = "postgres:17-alpine";

/**
 * Hands the Postgres lane a server: the one `POSTGRES_URL` names when it is set, otherwise a
 * container Testcontainers starts for the run and stops after it.
 *
 * Rejects, naming both remedies, when `POSTGRES_URL` is unset and no container can start.
 *
 * @example
 * ```ts
 * export default defineConfig({ test: { globalSetup: ["src/tests/postgres/global-setup.ts"] } });
 * ```
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const configured = process.env.POSTGRES_URL;

  if (configured) {
    project.provide("postgresUrl", configured);
    return undefined;
  }

  let container: StartedPostgreSqlContainer;

  try {
    container = await new PostgreSqlContainer(IMAGE).start();
  } catch (error) {
    throw new Error(
      `The Postgres lane found no server. Start Docker so Testcontainers can run ${IMAGE}, or set POSTGRES_URL ` +
        "to a connection string on a role allowed to create databases.",
      { cause: error },
    );
  }

  project.provide("postgresUrl", container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
