import { expect, test } from "vitest";
import { relationFieldsOf, relationFieldsTo, resolveRelationField } from "./datamodel.js";
import { disposableClient } from "./tests/factorio.js";

interface Field {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
}

// The scratch schema carries no model tag holding several capitals, so that case needs a stand-in
// for the client's `_runtimeDataModel`.
function clientWith(models: Record<string, Field[]>): unknown {
  const entries = Object.entries(models).map(([tag, fields]): [string, { fields: Field[] }] => [tag, { fields }]);
  return { _runtimeDataModel: { models: Object.fromEntries(entries) } };
}

test("the relation fields of a model that point at a target are read off the generated client", async () => {
  const prisma = await disposableClient();

  expect(relationFieldsTo(prisma, "post", "user")).toEqual(["author", "editor"]);
  expect(relationFieldsTo(prisma, "user", "post")).toEqual(["posts", "edited"]);
  expect(relationFieldsTo(prisma, "comment", "post")).toEqual(["post"]);
  expect(relationFieldsTo(prisma, "post", "comment")).toEqual(["comments"]);
  expect(relationFieldsTo(prisma, "comment", "user")).toEqual([]);
});

test("every relation field a model declares is read off the client, and none of its scalars", async () => {
  const prisma = await disposableClient();

  expect(relationFieldsOf(prisma, "post")).toEqual(["author", "editor", "comments"]);
  expect(relationFieldsOf(prisma, "user")).toEqual(["posts", "edited"]);
  expect(relationFieldsOf(prisma, "comment")).toEqual(["post"]);
  expect(relationFieldsOf(prisma, "psot")).toEqual([]);
});

test("a transaction client answers the same relation fields as the client it comes from", async () => {
  const prisma = await disposableClient();

  const inside = await prisma.$transaction((tx) => Promise.resolve(relationFieldsTo(tx, "post", "user")));

  expect(inside).toEqual(["author", "editor"]);
});

test("a model is named by its delegate key, which lowers the model tag's first letter alone", () => {
  const client = clientWith({ URLEntry: [], Hit: [{ name: "entry", kind: "object", type: "URLEntry" }] });

  expect(relationFieldsTo(client, "hit", "uRLEntry")).toEqual(["entry"]);
  expect(relationFieldsTo(client, "hit", "urlentry")).toEqual([]);
});

test("a client carrying no relation metadata is rejected", () => {
  expect(() => relationFieldsTo({ post: { create: () => undefined } }, "post", "user")).toThrow(
    "The client carries no relation metadata. Pass a generated Prisma client, not a hand-built object of delegates.",
  );
});

test("a relation field omitted with exactly one candidate resolves to that candidate", async () => {
  const prisma = await disposableClient();

  expect(resolveRelationField(prisma, "comment", "post")).toBe("post");
});

test("a model pair with no relation at all is rejected, naming both models", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "comment", "user")).toThrow(
    'The model "comment" has no relation field pointing at "user". Declare the relation in the Prisma schema.',
  );
});

test("a relation field omitted with more than one candidate is rejected, naming the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "post", "user")).toThrow(
    'The model "post" has more than one relation field pointing at "user": "author", "editor". ' +
      "Pass the relation field explicitly.",
  );
});

test("an explicit relation field that is a candidate resolves to itself", async () => {
  const prisma = await disposableClient();

  expect(resolveRelationField(prisma, "post", "user", "editor")).toBe("editor");
});

test("an explicit relation field that is not a candidate is rejected, naming it and the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "post", "user", "illustrator")).toThrow(
    'The model "post" has no relation field "illustrator" pointing at "user". Pass one of "author", "editor".',
  );
});

// `post` is a relation field of `comment`, but it points at another model, so the pair has no
// candidate to list back.
test("an explicit relation field pointing at another model reports the missing relation", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "comment", "user", "post")).toThrow(
    'The model "comment" has no relation field pointing at "user". Declare the relation in the Prisma schema.',
  );
});
