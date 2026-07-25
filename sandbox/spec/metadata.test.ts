import { describe, expect, it } from "vitest";
import { readMetadata } from "../lib/metadata.ts";

/** A client stub carrying just what `readMetadata` reads. */
const clientWith = (models: Record<string, { fields: unknown[] }>): object => {
  const delegates = Object.fromEntries(
    Object.keys(models).map((name) => [name.charAt(0).toLowerCase() + name.slice(1), { name }]),
  );
  return { ...delegates, _runtimeDataModel: { models } };
};

const selfRelation = (order: "managerFirst" | "reportsFirst"): object => {
  const manager = {
    name: "manager",
    kind: "object",
    type: "User",
    relationName: "UserReports",
  };
  const reports = {
    name: "reports",
    kind: "object",
    type: "User",
    relationName: "UserReports",
  };
  return clientWith({
    User: {
      fields: order === "managerFirst" ? [manager, reports] : [reports, manager],
    },
  });
};

describe("inverse resolution", () => {
  it("pairs a relation with its inverse", () => {
    const meta = readMetadata(
      clientWith({
        User: { fields: [{ name: "posts", kind: "object", type: "Post", relationName: "PostToUser" }] },
        Post: { fields: [{ name: "author", kind: "object", type: "User", relationName: "PostToUser" }] },
      }),
    );
    expect(meta.relation("User", "posts")).toEqual({ target: "Post", inverse: "author" });
    expect(meta.relation("Post", "author")).toEqual({ target: "User", inverse: "posts" });
  });

  it("keeps two relations between the same pair apart", () => {
    const meta = readMetadata(
      clientWith({
        User: {
          fields: [
            { name: "posts", kind: "object", type: "Post", relationName: "PostToUser" },
            { name: "reviewed", kind: "object", type: "Post", relationName: "PostReviewer" },
          ],
        },
        Post: {
          fields: [
            { name: "author", kind: "object", type: "User", relationName: "PostToUser" },
            { name: "reviewer", kind: "object", type: "User", relationName: "PostReviewer" },
          ],
        },
      }),
    );
    expect(meta.relation("User", "posts")?.inverse).toBe("author");
    expect(meta.relation("User", "reviewed")?.inverse).toBe("reviewer");
  });

  it("never matches a self relation field against itself, in either field order", () => {
    for (const order of ["managerFirst", "reportsFirst"] as const) {
      const meta = readMetadata(selfRelation(order));
      expect(meta.relation("User", "reports")?.inverse).toBe("manager");
      expect(meta.relation("User", "manager")?.inverse).toBe("reports");
    }
  });

  it("maps delegate names to payload names both ways", () => {
    const meta = readMetadata(clientWith({ User: { fields: [] } }));
    expect(meta.payloadName("user")).toBe("User");
    expect(meta.delegateName("User")).toBe("user");
  });
});
