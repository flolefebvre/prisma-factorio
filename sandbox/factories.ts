/**
 * Example factory definitions used by the design-verification tests. This file
 * doubles as the DX sample for docs/design/factory-api-proposal.md: it is what
 * a user of the library would write.
 */
import type { PrismaClient } from "./generated/client.ts";
import { createFactorio } from "./factorio.ts";

export const factorio = createFactorio<PrismaClient>();

export const UserFactory = factorio.define("user", {
  definition: ({ faker, seq }) => ({
    email: `user-${String(seq)}@example.com`,
    name: faker.person.fullName(),
  }),
  states: {
    suspended: () => ({ suspended: true }),
    withRole: (role: string) => ({ role }),
  },
});

export const PostFactory = factorio.define("post", {
  definition: ({ faker }) => ({
    title: faker.lorem.sentence(),
    author: UserFactory,
  }),
  states: {
    published: () => ({ published: true }),
  },
});

export const CommentFactory = factorio.define("comment", {
  definition: ({ faker }) => ({
    body: faker.lorem.paragraph(),
    post: PostFactory,
    author: UserFactory,
  }),
});

export const TagFactory = factorio.define("tag", {
  definition: ({ faker, seq }) => ({
    name: `${faker.word.noun()}-${String(seq)}`,
  }),
});

export const TeamFactory = factorio.define("team", {
  definition: ({ faker }) => ({
    name: faker.company.name(),
  }),
});

export const MembershipFactory = factorio.define("membership", {
  definition: () => ({
    user: UserFactory,
    team: TeamFactory,
  }),
  states: {
    asRole: (role: string) => ({ role }),
  },
});
