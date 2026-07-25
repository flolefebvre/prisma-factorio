import { defineFactory } from "../lib/index.ts";
import { prisma } from "./support.ts";

export const userFactory = defineFactory(prisma, "user", {
  define: ({ seq }) => ({
    email: `user${String(seq)}@example.com`,
    name: `User ${String(seq)}`,
  }),
  states: {
    admin: () => ({ role: "admin" }),
    unverified: () => ({ verifiedAt: null }),
    named: (name: string) => ({ name }),
  },
});

export const postFactory = defineFactory(prisma, "post", {
  define: ({ seq }) => ({
    title: `Post ${String(seq)}`,
    body: "lorem ipsum",
    author: userFactory,
  }),
  states: {
    published: () => ({ published: true }),
  },
});

export const tagFactory = defineFactory(prisma, "tag", {
  define: ({ seq }) => ({ name: `tag-${String(seq)}` }),
});

export const teamFactory = defineFactory(prisma, "team", {
  define: ({ seq }) => ({ name: `Team ${String(seq)}` }),
});
