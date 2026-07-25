import { cycle, factoryScope, lazy } from "../lib/index.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

/**
 * The definition surface a user of the library writes. Everything here is
 * checked against the generated client: model names, column names, value types
 * and which relations may hold a factory.
 */
export const buildFactories = (prisma: PrismaClient) => {
  const { define, use, withClient, resetSequence } = factoryScope(prisma);

  const user = define("user", {
    fields: {
      name: lazy(({ seq }) => `User ${String(seq)}`),
      email: lazy(({ seq }) => `user-${String(seq)}@example.com`),
      emailVerifiedAt: new Date("2026-01-01"),
    },
    states: {
      admin: { role: "admin" },
      unverified: { emailVerifiedAt: null },
    },
  });

  const post = define("post", {
    fields: {
      title: lazy(({ seq }) => `Post ${String(seq)}`),
      content: lazy(({ attrs }) => `Body of ${String(attrs.title)}`),
      author: use("user"),
    },
    states: {
      published: { published: true },
    },
  });

  const profile = define("profile", {
    fields: { bio: lazy(({ seq }) => `Bio ${String(seq)}`), user: use("user") },
  });

  const tag = define("tag", {
    fields: { name: lazy(({ seq }) => `tag-${String(seq)}`) },
  });

  const tagging = define("tagging", {
    fields: { post: use("post"), tag: use("tag"), public: cycle(true, false) },
  });

  const airline = define("airline", {
    fields: { name: lazy(({ seq }) => `Airline ${String(seq)}`) },
  });

  const flight = define("flight", {
    fields: { number: lazy(({ seq }) => `FL${String(seq)}`), airline: use("airline") },
  });

  const ticket = define("ticket", {
    fields: {
      seat: lazy(({ seq }) => `A${String(seq)}`),
      airline: use("airline"),
      flight: use("flight"),
      user: use("user"),
    },
  });

  return { user, post, profile, tag, tagging, airline, flight, ticket, withClient, resetSequence };
};

export type Factories = ReturnType<typeof buildFactories>;
