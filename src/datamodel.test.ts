import { expect, test } from "vitest";
import {
  holdsManyRecords,
  inverseRelationField,
  namedRelationField,
  relationFieldsOf,
  relationFieldsTo,
  resolveRelationField,
  resolveRowRelationField,
  targetScalars,
} from "./datamodel.js";
import { disposableClient } from "./tests/factorio.js";

const postShape = { id: 1, title: "Hello", authorId: 1, editorId: null };
const userShape = { id: 1, email: "ada@example.com", name: null };

const severalFields =
  'The model "post" has more than one relation field pointing at "user". Pass the relation field explicitly. ' +
  'Relation fields on "post" pointing at "user": "author", "editor".';

const unsharedField =
  'The model "post" has no relation field "illustrator" pointing at "user". ' +
  'Relation fields on "post" pointing at "user": "author", "editor".';

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

// The scratch schema pairs every relation field it declares, so the shapes a Prisma release could
// hand back instead need a stand-in too: `user` holds the fields under test, `post` the far side.
function relating(fields: Field[]): unknown {
  return clientWith({
    User: fields,
    Post: [{ name: "author", kind: "object", type: "User", relationName: "written" }],
  });
}

// The scratch schema holds no model relating to itself, the one shape putting both sides of a
// pairing on one model.
function selfRelating(...names: string[]): unknown {
  return clientWith({ Node: names.map((name) => ({ name, kind: "object", type: "Node", relationName: "tree" })) });
}

// The query the arity is read off reaches a database, which a stand-in client answers in its place:
// `user` holds the relation field under test, `posts`, and `Post` the fields its target declares.
function probing(findFirst: (args: unknown) => Promise<unknown>, target: Field[] = []): unknown {
  const client = clientWith({
    User: [{ name: "posts", kind: "object", type: "Post", relationName: "authored" }],
    Post: [{ name: "author", kind: "object", type: "User", relationName: "authored" }, ...target],
  });

  return { ...(client as object), user: { findFirst } };
}

function scalars(...names: string[]): Field[] {
  return names.map((name) => ({ name, kind: "scalar", type: "String" }));
}

// Prisma names the class it raised on the instance, and only the one it raises for a query it
// refuses to send stands for an arity.
function raising(name: string): Error {
  return Object.assign(new Error("no such table"), { name });
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

  expect(relationFieldsOf(prisma, "post")).toEqual(["author", "editor", "comments", "tags"]);
  expect(relationFieldsOf(prisma, "user")).toEqual(["posts", "edited", "memberships"]);
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

// The listed fields are reported as what they are rather than as what to pass: the runtime datamodel
// carries no arity, and the query it is read off instead is one this lookup does not make, so the
// list can hold a field holding many records, which for() rejects.
test("a relation field omitted with more than one candidate is rejected, naming the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "post", "user")).toThrow(severalFields);
});

test("an explicit relation field that is a candidate resolves to itself", async () => {
  const prisma = await disposableClient();

  expect(resolveRelationField(prisma, "post", "user", "editor")).toBe("editor");
});

test("an explicit relation field that is not a candidate is rejected, naming it and the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "post", "user", "illustrator")).toThrow(unsharedField);
});

// `post` is a relation field of `comment`, but it points at another model, so the pair has no
// candidate to list back.
test("an explicit relation field pointing at another model reports the missing relation", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRelationField(prisma, "comment", "user", "post")).toThrow(
    'The model "comment" has no relation field pointing at "user". Declare the relation in the Prisma schema.',
  );
});

test("a name the model declares as a relation field resolves to itself", async () => {
  const prisma = await disposableClient();

  expect(namedRelationField(prisma, "user", "edited")).toBe("edited");
});

// The model at the far end is what tells a relation field from a scalar apart from the caller, and a
// call reaching here has none to name, so both misses are reported as the one thing they have in
// common: the model declares no relation field under that name.
test("a name the model declares as no relation field is rejected, naming it and the fields it holds", async () => {
  const prisma = await disposableClient();

  for (const name of ["illustrated", "email"]) {
    expect(() => namedRelationField(prisma, "user", name)).toThrow(
      `The model "user" has no relation field "${name}". Relation fields on "user": "posts", "edited", "memberships".`,
    );
  }
});

test("a row resolves the relation field through the one target model its own fields fit", async () => {
  const prisma = await disposableClient();

  expect(resolveRowRelationField(prisma, "comment", postShape)).toBe("post");
});

test("a row is narrowed to the scalars of the model a relation field points at", async () => {
  const prisma = await disposableClient();

  expect(targetScalars(prisma, "post", "author", { ...userShape, posts: [], edited: [] })).toStrictEqual(userShape);
  expect(targetScalars(prisma, "comment", "post", postShape)).toStrictEqual(postShape);
});

test("a relation field the model does not declare hands the row back whole", async () => {
  const prisma = await disposableClient();

  expect(targetScalars(prisma, "post", "illustrator", userShape)).toStrictEqual(userShape);
});

// `include` hands back the loaded relation alongside the scalars, and the relation it names belongs
// to the very model the row is being matched against.
test("a row carrying loaded relations fits the model its scalars belong to", async () => {
  const prisma = await disposableClient();

  expect(resolveRowRelationField(prisma, "comment", { ...postShape, comments: [] })).toBe("post");
});

test("a row fitting no target model of the child is rejected, naming the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRowRelationField(prisma, "comment", userShape)).toThrow(
    'The row fits no single model the relation fields of "comment" point at. ' +
      'Pass the relation field explicitly. Relation fields on "comment": "post".',
  );
});

// Every model declares an `id`, so a row narrowed to it fits all of them.
test("a row fitting several target models of the child is rejected, naming the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRowRelationField(prisma, "post", { id: 1 })).toThrow(
    'The row fits no single model the relation fields of "post" point at. ' +
      'Pass the relation field explicitly. Relation fields on "post": "author", "editor", "comments", "tags".',
  );
});

test("a row fitting one target model reached by several relation fields reports them", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRowRelationField(prisma, "post", userShape)).toThrow(severalFields);
});

// The named field carries its own target, so a row too narrow to single one out still resolves.
test("an explicit relation field names its target rather than reading the row's fields", async () => {
  const prisma = await disposableClient();

  expect(resolveRowRelationField(prisma, "post", { id: 1 }, "editor")).toBe("editor");
});

test("an explicit relation field the model does not declare is rejected, naming it and the candidates", async () => {
  const prisma = await disposableClient();

  expect(() => resolveRowRelationField(prisma, "post", userShape, "illustrator")).toThrow(unsharedField);
});

// `comments` and `post` are paired by a label Prisma generates rather than one the schema names, so
// the pairing is read the same way whether or not `@relation` carries a name.
test("the inverse of a relation field is the field the target model pairs it with", async () => {
  const prisma = await disposableClient();

  expect(inverseRelationField(prisma, "user", "posts")).toBe("author");
  expect(inverseRelationField(prisma, "post", "author")).toBe("posts");
  expect(inverseRelationField(prisma, "user", "edited")).toBe("editor");
  expect(inverseRelationField(prisma, "post", "comments")).toBe("post");
  expect(inverseRelationField(prisma, "comment", "post")).toBe("comments");
});

test("a field the model does not declare is rejected, naming the relation fields it holds", async () => {
  const prisma = await disposableClient();

  expect(() => inverseRelationField(prisma, "user", "psots")).toThrow(
    'The model "user" declares no field "psots". Relation fields on "user": "posts", "edited", "memberships".',
  );
});

test("a field the model declares as something other than a relation is rejected", async () => {
  const prisma = await disposableClient();

  expect(() => inverseRelationField(prisma, "user", "email")).toThrow(
    'The field "email" on the model "user" is not a relation field. Relation fields on "user": "posts", "edited", "memberships".',
  );
});

test("a model holding no relation field at all is reported as holding none", () => {
  const client = clientWith({ Log: [{ name: "message", kind: "scalar", type: "String" }] });

  expect(() => inverseRelationField(client, "log", "message")).toThrow(
    'The field "message" on the model "log" is not a relation field. Relation fields on "log": none.',
  );
});

test("a relation field the datamodel pairs with nothing at all is rejected", () => {
  const client = relating([{ name: "posts", kind: "object", type: "Post" }]);

  expect(() => inverseRelationField(client, "user", "posts")).toThrow(
    'The relation field "posts" on the model "user" carries no metadata pairing it with a relation field on "post". ' +
      'Pass the inverse relation field as the "inverse" option of has(). Relation fields on "post": "author".',
  );
});

test("a relation field nothing on the target model pairs with is rejected", () => {
  const client = relating([{ name: "posts", kind: "object", type: "Post", relationName: "authored" }]);

  expect(() => inverseRelationField(client, "user", "posts")).toThrow(
    'The model "post" has no relation field pairing with "posts" on "user". ' +
      'Pass the inverse relation field as the "inverse" option of has(). Relation fields on "post": "author".',
  );
});

test("a self-relation pairs each of its two sides with the other rather than with itself", () => {
  const client = selfRelating("parent", "children");

  expect(inverseRelationField(client, "node", "children")).toBe("parent");
  expect(inverseRelationField(client, "node", "parent")).toBe("children");
});

test("more than one relation field pairing with the one the lookup starts from is rejected, naming them", () => {
  const client = selfRelating("parent", "children", "leaves");

  expect(() => inverseRelationField(client, "node", "parent")).toThrow(
    'The model "node" has more than one relation field pairing with "parent" on "node". ' +
      'Pass the inverse relation field as the "inverse" option of has(). ' +
      'Relation fields on "node" pairing with "parent" on "node": "children", "leaves".',
  );
});

// The many side of a one-to-many, both sides of an implicit many-to-many and the many side onto a
// join model all hold many records, and none of them is marked as such in the runtime datamodel.
test("a relation field holding many records is reported as holding many", async () => {
  const prisma = await disposableClient();

  expect(await holdsManyRecords(prisma, "post", "comments")).toBe(true);
  expect(await holdsManyRecords(prisma, "post", "tags")).toBe(true);
  expect(await holdsManyRecords(prisma, "tag", "posts")).toBe(true);
  expect(await holdsManyRecords(prisma, "user", "memberships")).toBe(true);
});

// A required belongs-to side, an optional one and a leg of a compound-keyed join model all hold one
// record, which is what the relation defaults of a definition connect rather than create in turn.
test("a relation field holding one record is reported as holding one", async () => {
  const prisma = await disposableClient();

  expect(await holdsManyRecords(prisma, "post", "author")).toBe(false);
  expect(await holdsManyRecords(prisma, "post", "editor")).toBe(false);
  expect(await holdsManyRecords(prisma, "comment", "post")).toBe(false);
  expect(await holdsManyRecords(prisma, "membership", "team")).toBe(false);
});

test("a transaction client answers the same arity as the client it comes from", async () => {
  const prisma = await disposableClient();

  const inside = await prisma.$transaction((tx) => holdsManyRecords(tx, "post", "comments"));

  expect(inside).toBe(true);
});

// A relation filter is what the arity is read off, and a scalar takes none, so a name the model
// declares as anything but a relation field would answer as one holding a single record.
test("a name the model declares as no relation field has no arity to report", async () => {
  const prisma = await disposableClient();

  for (const name of ["title", "titel"]) {
    await expect(holdsManyRecords(prisma, "post", name)).rejects.toThrow(
      `The model "post" has no relation field "${name}". ` +
        'Relation fields on "post": "author", "editor", "comments", "tags".',
    );
  }
});

// The probe costs a query, and the schema a client is generated from cannot change under it, so the
// answer is held for that client rather than asked again.
test("the arity of a relation field is probed once per client and held afterwards", async () => {
  const asked: unknown[] = [];
  const client = probing((args) => {
    asked.push(args);
    return Promise.resolve(null);
  });

  const answers = [await holdsManyRecords(client, "user", "posts"), await holdsManyRecords(client, "user", "posts")];

  expect(answers).toEqual([true, true]);
  expect(asked).toHaveLength(1);
});

// A relation field holding a single record takes the target model's own where-input alongside the
// one-record filter, so a key naming a field of that model validates there too and answers nothing.
// The three keys a many-record filter takes are the ones the probe picks from.
test("the probe names a filter key the target model declares no field under", async () => {
  const asked: unknown[] = [];
  const record = (args: unknown): Promise<unknown> => {
    asked.push(args);
    return Promise.resolve(null);
  };

  for (const taken of [[], scalars("some"), scalars("some", "every")]) {
    await holdsManyRecords(probing(record, taken), "user", "posts");
  }

  expect(asked).toEqual([
    { where: { posts: { some: {} } } },
    { where: { posts: { every: {} } } },
    { where: { posts: { none: {} } } },
  ]);
});

// A query the database refused — a missing table, a dropped connection — says nothing about the
// schema, so it reaches the caller in place of standing for a relation field holding one record.
test("a query the database refused is rethrown rather than read as an arity", async () => {
  const client = probing(() => Promise.reject(raising("PrismaClientKnownRequestError")));

  await expect(holdsManyRecords(client, "user", "posts")).rejects.toThrow("no such table");
});

test("a query the database refused leaves nothing held, so the next ask probes again", async () => {
  const answers: (Error | null)[] = [raising("PrismaClientKnownRequestError"), null];
  const client = probing(() => {
    const next = answers.shift();

    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });

  await expect(holdsManyRecords(client, "user", "posts")).rejects.toThrow("no such table");

  expect(await holdsManyRecords(client, "user", "posts")).toBe(true);
});

test("a client carrying relation metadata but no delegate for the model is rejected", async () => {
  const client = relating([{ name: "posts", kind: "object", type: "Post", relationName: "written" }]);

  await expect(holdsManyRecords(client, "user", "posts")).rejects.toThrow(
    'The client carries no delegate for the model "user". Pass a generated Prisma client, not its relation metadata alone.',
  );
});
