/**
 * Probes Prisma 7 runtime behavior relevant to the factory design:
 * 1. nested writes for has/for composition
 * 2. whether `connect` tolerates extra (non-unique) fields
 * 3. what schema metadata the client instance exposes at runtime
 */
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/client.ts";

const adapter = new PrismaBetterSqlite3({
  url: `file:${path.join(import.meta.dirname, "..", "dev.db")}`,
});
const prisma = new PrismaClient({ adapter });

// clean slate
await prisma.membership.deleteMany();
await prisma.comment.deleteMany();
await prisma.post.deleteMany();
await prisma.tag.deleteMany();
await prisma.team.deleteMany();
await prisma.user.deleteMany();

// 1a. has-many via nested create
const user = await prisma.user.create({
  data: {
    email: "a@example.com",
    name: "Alice",
    posts: { create: [{ title: "P1" }, { title: "P2" }] },
  },
  include: { posts: true },
});
console.log("1a nested has-many OK, posts:", user.posts.length);

// 1b. belongs-to via nested create + implicit m-n + explicit pivot
const post = await prisma.post.create({
  data: {
    title: "P3",
    author: { create: { email: "b@example.com", name: "Bob" } },
    tags: { create: [{ name: "t1" }] },
  },
  include: { author: true, tags: true },
});
console.log("1b nested belongs-to OK, author:", post.author.name, "tags:", post.tags.length);

const team = await prisma.team.create({
  data: {
    name: "T1",
    memberships: {
      create: [{ role: "owner", user: { connect: { id: user.id } } }],
    },
  },
  include: { memberships: true },
});
console.log("1c explicit pivot OK, role:", team.memberships[0]?.role);

// 2. connect with the full record (extra non-unique fields)
try {
  const c = await prisma.post.create({
    data: {
      title: "P4",
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      author: { connect: user as unknown as { id: number } },
    },
  });
  console.log("2 connect with full record: ACCEPTED", c.authorId);
} catch (e) {
  console.log("2 connect with full record: REJECTED —", (e as Error).message.split("\n").slice(-3).join(" "));
}

// 3. runtime metadata on the client instance
const anyClient = prisma as unknown as Record<string, unknown>;
const metaKeys = Object.keys(anyClient).filter((k) => /datamodel|dmmf|schema|config/i.test(k));
console.log("3 instance keys matching metadata:", metaKeys);
const rdm = anyClient._runtimeDataModel as
  { models: Record<string, { fields: { name: string; kind: string }[] }> } | undefined;
console.log("3 _runtimeDataModel present:", !!rdm, rdm ? Object.keys(rdm.models) : "");
const engineConfig = anyClient._engineConfig as { inlineSchema?: string } | undefined;
console.log("3 _engineConfig.inlineSchema present:", typeof engineConfig?.inlineSchema === "string");

await prisma.$disconnect();
