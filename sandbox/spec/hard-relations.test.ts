import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.ts";
import { freshClient } from "./db.ts";
import { buildFactories, type Factories } from "./factories.ts";

let prisma: PrismaClient;
let f: Factories;

beforeAll(async () => {
  prisma = await freshClient("hard-relations");
  f = buildFactories(prisma);
});

describe("two relations between the same pair of models", () => {
  it("nests under the right inverse for each relation", async () => {
    const author = await f.user.has("posts", 2).create();
    expect(author.posts.every((p) => p.authorId === author.id)).toBe(true);
    // `reviewer` is a separate relation and must not be filled by `posts`.
    expect(author.posts.every((p) => p.reviewerId === null)).toBe(true);

    const reviewer = await f.user.has("reviewed", 2).create();
    expect(reviewer.reviewed.every((p) => p.reviewerId === reviewer.id)).toBe(true);
    // The child still gets its own author from the definition.
    expect(reviewer.reviewed.every((p) => p.authorId !== reviewer.id)).toBe(true);
  });

  it("attaches a specific parent per relation with for()", async () => {
    const author = await f.user.create();
    const reviewer = await f.user.create();
    const post = await f.post.for("author", author).for("reviewer", reviewer).create();
    expect(post.authorId).toBe(author.id);
    expect(post.reviewerId).toBe(reviewer.id);
  });
});

describe("self relations", () => {
  it("creates a parent on a self to-one relation", async () => {
    const report = await f.user.for("manager", f.user).create();
    expect(report.managerId).not.toBeNull();
    expect(report.manager?.id).not.toBe(report.id);
  });

  it("creates children on a self to-many relation", async () => {
    const manager = await f.user.has("reports", 2).create();
    expect(manager.reports).toHaveLength(2);
    expect(manager.reports.every((r) => r.managerId === manager.id)).toBe(true);
  });
});
