import { expect, test } from "vitest";
import { relationFieldsTo, resolveRelationField } from "./datamodel.js";
import { disposableClient } from "./tests/factorio.js";

interface Field {
  name: string;
  kind: string;
  type: string;
  relationName?: string;
}

// The scratch schema holds no model pair sharing exactly one relation and no model tag carrying
// several capitals, so those cases need a stand-in for the client's `_runtimeDataModel`.
function clientWith(models: Record<string, Field[]>): unknown {
  const entries = Object.entries(models).map(([tag, fields]): [string, { fields: Field[] }] => [tag, { fields }]);
  return { _runtimeDataModel: { models: Object.fromEntries(entries) } };
}

function relation(name: string, type: string): Field {
  return { name, kind: "object", type, relationName: name };
}

function bookshelf(...names: string[]): unknown {
  const title: Field = { name: "title", kind: "scalar", type: "String" };
  return clientWith({ Author: [], Book: [title, ...names.map((name) => relation(name, "Author"))] });
}

test("the relation fields of a model that point at a target are read off the generated client", async () => {
  const prisma = await disposableClient();

  expect(relationFieldsTo(prisma, "post", "user")).toEqual(["author", "editor"]);
  expect(relationFieldsTo(prisma, "user", "post")).toEqual(["posts", "edited"]);
});

test("a transaction client answers the same relation fields as the client it comes from", async () => {
  const prisma = await disposableClient();

  const inside = await prisma.$transaction((tx) => Promise.resolve(relationFieldsTo(tx, "post", "user")));

  expect(inside).toEqual(["author", "editor"]);
});

test("a model is named by its delegate key, which lowers the model tag's first letter alone", () => {
  const client = clientWith({ URLEntry: [], Hit: [relation("entry", "URLEntry")] });

  expect(relationFieldsTo(client, "hit", "uRLEntry")).toEqual(["entry"]);
  expect(relationFieldsTo(client, "hit", "urlentry")).toEqual([]);
});

test("a client carrying no relation metadata is rejected", () => {
  expect(() => relationFieldsTo({ post: { create: () => undefined } }, "post", "user")).toThrow(
    "The client carries no relation metadata. Pass a generated Prisma client, not a hand-built object of delegates.",
  );
});

test("a relation field omitted with exactly one candidate resolves to that candidate", () => {
  expect(resolveRelationField(bookshelf("writer"), "book", "author")).toBe("writer");
});

test("a model pair with no relation at all is rejected, naming both models", () => {
  expect(() => resolveRelationField(bookshelf(), "book", "author")).toThrow(
    'The model "book" has no relation field pointing at "author". Declare the relation in the Prisma schema.',
  );
});

test("a relation field omitted with more than one candidate is rejected, naming the candidates", () => {
  expect(() => resolveRelationField(bookshelf("writer", "editor"), "book", "author")).toThrow(
    'The model "book" has more than one relation field pointing at "author": "writer", "editor". ' +
      "Pass the relation field explicitly.",
  );
});

test("an explicit relation field that is a candidate resolves to itself", () => {
  expect(resolveRelationField(bookshelf("writer", "editor"), "book", "author", "editor")).toBe("editor");
});

test("an explicit relation field that is not a candidate is rejected, naming it and the candidates", () => {
  expect(() => resolveRelationField(bookshelf("writer", "editor"), "book", "author", "illustrator")).toThrow(
    'The model "book" has no relation field "illustrator" pointing at "author". Pass one of "writer", "editor".',
  );
});

test("an explicit relation field on a model pair with no relation at all reports the missing relation", () => {
  expect(() => resolveRelationField(bookshelf(), "book", "author", "writer")).toThrow(
    'The model "book" has no relation field pointing at "author". Declare the relation in the Prisma schema.',
  );
});
