import * as path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/client.ts";
import { defineFactory } from "./factorio.ts";

export const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: "file:" + path.join(import.meta.dirname, "dev.db"),
  }),
});

export const UserFactory = defineFactory(prisma, "user", {
  definition: ({ seq }) => ({
    email: `user-${seq}@example.test`,
    name: `User ${seq}`,
  }),
  states: {
    admin: () => ({ role: "ADMIN" }),
    named: (_ctx, name: string) => ({ name }),
  },
});

export const PostFactory = defineFactory(prisma, "post", {
  definition: ({ seq }) => ({
    title: `Post ${seq}`,
    author: UserFactory,
  }),
  states: {
    published: () => ({ published: true }),
  },
});

export const ProfileFactory = defineFactory(prisma, "profile", {
  definition: ({ seq }) => ({
    bio: `Bio ${seq}`,
    user: UserFactory,
  }),
});

export const TagFactory = defineFactory(prisma, "tag", {
  definition: ({ seq }) => ({ name: `tag-${seq}` }),
});

export const TeamFactory = defineFactory(prisma, "team", {
  definition: ({ seq }) => ({ name: `Team ${seq}` }),
});

export const MembershipFactory = defineFactory(prisma, "teamMembership", {
  definition: () => ({
    user: UserFactory,
    team: TeamFactory,
  }),
});
