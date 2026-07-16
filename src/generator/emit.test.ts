import { expect, test } from "vitest";
import { datamodelFixture, fieldFixture, generatorConfigFixture, modelFixture } from "../tests/dmmf.ts";
import {
  emitBarrelFile,
  emitFactoryFiles,
  emitModelFactoryFile,
  GENERATED_FILE_MARKER,
  resolveClientImportDir,
} from "./emit.ts";

test("a model emits a file named after the model", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "User" }), "../client");

  expect(file.path).toBe("User.ts");
});

test("the emitted base class is abstract and pins the Factory generics to the model CreateInput and Model", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "Post" }), "../client");

  expect(file.content).toContain("export abstract class PostFactoryBase extends Factory<PostCreateInput, PostModel> {");
});

test("the emitted base class bakes the model's Prisma delegate name", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "Post" }), "../client");

  expect(file.content).toContain('protected readonly prismaDelegate = "post";');
});

test("the baked delegate name lowercases only the first letter of a multi-word model name", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "UserProfile" }), "../client");

  expect(file.content).toContain('protected readonly prismaDelegate = "userProfile";');
});

// "aPIKey" must match Prisma's own lowerFirst delegate mapping (model APIKey
// -> prisma.aPIKey), however wrong it looks; a "nicer" apiKey would typecheck
// fine and miss the delegate at runtime.
test("an acronym-led model name bakes Prisma's lowerFirst delegate name verbatim", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "APIKey" }), "../client");

  expect(file.content).toContain('protected readonly prismaDelegate = "aPIKey";');
});

test("a model with no relation fields emits the unchanged two-generic base with no definition type", () => {
  const file = emitModelFactoryFile(
    modelFixture({ name: "User", fields: [fieldFixture({ name: "email" })] }),
    "../client",
  );

  expect(file.content).toContain("export abstract class UserFactoryBase extends Factory<UserCreateInput, UserModel> {");
  expect(file.content).not.toContain("FactoryDefinition");
  expect(file.content).not.toContain("FactoryValue");
});

test("a model with a to-one relation pins a third definition generic that widens the relation field", () => {
  const file = emitModelFactoryFile(
    modelFixture({
      name: "Post",
      fields: [fieldFixture({ name: "title" }), fieldFixture({ name: "author", kind: "object", type: "User" })],
    }),
    "../client",
  );

  expect(file.content).toContain(
    "export abstract class PostFactoryBase<TResult = PostModel> extends Factory<\n" +
      "  PostCreateInput,\n" +
      "  PostModel,\n" +
      "  PostFactoryDefinition,\n" +
      "  TResult\n" +
      "> {",
  );
  expect(file.content).toContain("type PostRelationFactories = {\n  author: FactoryValue<UserFactoryBase>;\n};");
  expect(file.content).toContain(
    "export type PostFactoryDefinition = {\n" +
      "  [K in keyof PostCreateInput]: K extends keyof PostRelationFactories\n" +
      "    ? PostCreateInput[K] | PostRelationFactories[K]\n" +
      "    : PostCreateInput[K];\n" +
      "};",
  );
});

test("a relational model imports FactoryValue from the runtime and each related base from its sibling file", () => {
  const file = emitModelFactoryFile(
    modelFixture({
      name: "Post",
      fields: [fieldFixture({ name: "author", kind: "object", type: "User" })],
    }),
    "../client",
  );

  expect(file.content).toContain('import { Factory, type FactoryValue } from "prisma-factorio/factories";');
  expect(file.content).toContain('import type { UserFactoryBase, UserFactoryDefinition } from "./User.ts";');
});

test("multiple relations to distinct models each import once and appear in the relation map", () => {
  const file = emitModelFactoryFile(
    modelFixture({
      name: "Post",
      fields: [
        fieldFixture({ name: "author", kind: "object", type: "User" }),
        fieldFixture({ name: "category", kind: "object", type: "Category" }),
      ],
    }),
    "../client",
  );

  expect(file.content).toContain('import type { UserFactoryBase, UserFactoryDefinition } from "./User.ts";');
  expect(file.content).toContain(
    'import type { CategoryFactoryBase, CategoryFactoryDefinition } from "./Category.ts";',
  );
  expect(file.content).toContain(
    "type PostRelationFactories = {\n" +
      "  author: FactoryValue<UserFactoryBase>;\n" +
      "  category: FactoryValue<CategoryFactoryBase>;\n" +
      "};",
  );
});

test("two relations to the same model import that base only once", () => {
  const file = emitModelFactoryFile(
    modelFixture({
      name: "Message",
      fields: [
        fieldFixture({ name: "sender", kind: "object", type: "User" }),
        fieldFixture({ name: "recipient", kind: "object", type: "User" }),
      ],
    }),
    "../client",
  );

  const imports = file.content.match(/import type \{ UserFactoryBase, UserFactoryDefinition \} from "\.\/User\.ts";/g);
  expect(imports).toHaveLength(1);
});

test("a self-relation widens the field without importing the model's own base", () => {
  const file = emitModelFactoryFile(
    modelFixture({
      name: "Category",
      fields: [fieldFixture({ name: "parent", kind: "object", type: "Category" })],
    }),
    "../client",
  );

  expect(file.content).toContain("parent: FactoryValue<CategoryFactoryBase>;");
  expect(file.content).not.toContain(
    'import type { CategoryFactoryBase, CategoryFactoryDefinition } from "./Category.ts";',
  );
});

test("a to-one relation emits a forX method whose overloads grow TResult and whose body bakes the id field", () => {
  const post = modelFixture({
    name: "Post",
    fields: [fieldFixture({ name: "author", kind: "object", type: "User", relationName: "Author" })],
  });
  const user = modelFixture({ name: "User", fields: [fieldFixture({ name: "id", type: "String", isId: true })] });

  const file = emitModelFactoryFile(post, "../client", [post, user]);

  expect(file.content).toContain(
    "  forAuthor<TChild>(factory: UserFactoryBase<TChild>): PostFactoryBase<TResult & { author: TChild }>;",
  );
  expect(file.content).toContain(
    "  forAuthor(arg: UserModel | Partial<UserFactoryDefinition>): PostFactoryBase<TResult & { author: UserModel }>;",
  );
  expect(file.content).toContain('    return this.declareToOne("author", "User", "id", "forAuthor", arg);');
});

test("a to-many relation emits a hasX method with count, factory, list, and array forms and imports ListFactory", () => {
  const user = modelFixture({
    name: "User",
    fields: [fieldFixture({ name: "posts", kind: "object", type: "Post", isList: true, relationName: "Author" })],
  });
  const post = modelFixture({
    name: "Post",
    fields: [
      fieldFixture({ name: "id", type: "Int", isId: true }),
      fieldFixture({ name: "author", kind: "object", type: "User", relationName: "Author" }),
    ],
  });

  const file = emitModelFactoryFile(user, "../client", [user, post]);

  expect(file.content).toContain(
    'import { Factory, type FactoryValue, type ListFactory } from "prisma-factorio/factories";',
  );
  expect(file.content).toContain(
    "  hasPosts(count: number, overrides?: Partial<PostFactoryDefinition>): UserFactoryBase<TResult & { posts: PostModel[] }>;",
  );
  expect(file.content).toContain(
    "  hasPosts<TChild>(factories: PostFactoryBase<TChild>[]): UserFactoryBase<TResult & { posts: TChild[] }>;",
  );
  // The baked inverse field is the child's belongsTo that points back at the
  // parent, dropped from each child so the nesting does not re-create it.
  expect(file.content).toContain('    return this.declareToMany("posts", "Post", "author", arg, overrides);');
});

test("the emitted file imports Factory from the prisma-factorio runtime", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "User" }), "../client");

  expect(file.content).toContain('import { Factory } from "prisma-factorio/factories";');
});

test("the emitted file imports the model CreateInput and Model types from the client models barrel", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "User" }), "../../custom/client");

  expect(file.content).toContain('import type { UserCreateInput, UserModel } from "../../custom/client/models.ts";');
});

test("a datamodel emits one factory base file per model plus a barrel index", () => {
  const datamodel = datamodelFixture([modelFixture({ name: "User" }), modelFixture({ name: "Post" })]);

  const files = emitFactoryFiles({
    datamodel,
    outputDir: "/app/generated/prisma-factorio",
    otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/custom/client" })],
  });

  expect(files.map((file) => file.path)).toEqual(["User.ts", "Post.ts", "index.ts"]);
  expect(files[0]?.content).toContain('from "../../custom/client/models.ts"');
  expect(files[2]?.content).toContain('import type { PrismaClient } from "../../custom/client/client.ts";');
});

test("the barrel re-exports every model factory base from its model file", () => {
  const file = emitBarrelFile([modelFixture({ name: "User" }), modelFixture({ name: "Post" })], "../client");

  expect(file.path).toBe("index.ts");
  expect(file.content).toContain('export { UserFactoryBase } from "./User.ts";');
  expect(file.content).toContain('export { PostFactoryBase } from "./Post.ts";');
});

test("the barrel emits a typed initPrismaFactorio wrapper bound to the schema's PrismaClient", () => {
  const file = emitBarrelFile([modelFixture({ name: "User" })], "../../custom/client");

  expect(file.content).toContain('import type { PrismaClient } from "../../custom/client/client.ts";');
  expect(file.content).toContain("import { initPrismaFactorio as initPrismaFactorioRuntime,");
  expect(file.content).toContain(
    "export function initPrismaFactorio(options: { prisma: PrismaClient | (() => PrismaClient) }): void {",
  );
  expect(file.content).toContain("initPrismaFactorioRuntime(options);");
});

test("the barrel emits a typed registerFactories wrapper keyed by every model", () => {
  const file = emitBarrelFile([modelFixture({ name: "User" }), modelFixture({ name: "Post" })], "../client");

  expect(file.content).toContain(
    'import { initPrismaFactorio as initPrismaFactorioRuntime, registerFactories as registerFactoriesRuntime, type RegisterableFactory } from "prisma-factorio/factories";',
  );
  expect(file.content).toContain('import type { UserFactoryBase } from "./User.ts";');
  expect(file.content).toContain('import type { PostFactoryBase } from "./Post.ts";');
  expect(file.content).toContain(
    "export function registerFactories(factories: {\n" +
      "  User?: new () => UserFactoryBase;\n" +
      "  Post?: new () => PostFactoryBase;\n" +
      "}): void {",
  );
  expect(file.content).toContain("registerFactoriesRuntime(factories as Record<string, RegisterableFactory>);");
});

test("the barrel starts with a generated-file header comment", () => {
  const file = emitBarrelFile([modelFixture({ name: "User" })], "../client");

  expect(file.content).toMatch(/^\/\/ Generated by prisma-factorio\./);
});

test("the emitted file starts with a generated-file header comment", () => {
  const file = emitModelFactoryFile(modelFixture({ name: "User" }), "../client");

  expect(file.content).toMatch(/^\/\/ Generated by prisma-factorio\./);
});

test("every emitted file starts with the shared generated-file marker", () => {
  const modelFile = emitModelFactoryFile(modelFixture({ name: "User" }), "../client");
  const barrelFile = emitBarrelFile([modelFixture({ name: "User" })], "../client");

  expect(modelFile.content.startsWith(`${GENERATED_FILE_MARKER}\n`)).toBe(true);
  expect(barrelFile.content.startsWith(`${GENERATED_FILE_MARKER}\n`)).toBe(true);
});

test("a single prisma-client generator resolves to a relative dir from the factory output dir", () => {
  const dir = resolveClientImportDir({
    outputDir: "/app/generated/prisma-factorio",
    otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" })],
  });

  expect(dir).toBe("../client");
});

test("a client dir nested under the factory output dir resolves with a ./ prefix", () => {
  const dir = resolveClientImportDir({
    outputDir: "/app/generated",
    otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" })],
  });

  expect(dir).toBe("./client");
});

test("clientOutput overrides otherGenerators detection", () => {
  const dir = resolveClientImportDir({
    outputDir: "/app/generated/prisma-factorio",
    otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" })],
    clientOutput: "/app/custom/client",
  });

  expect(dir).toBe("../../custom/client");
});

test("a factory output dir equal to the clientOutput dir fails naming both directories", () => {
  const resolve = () =>
    resolveClientImportDir({
      outputDir: "/app/generated/shared",
      otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" })],
      clientOutput: "/app/generated/shared",
    });

  expect(resolve).toThrow(/\/app\/generated\/shared.*\/app\/generated\/shared/);
  expect(resolve).toThrow(/`output` must differ from the client output/);
});

test("a factory output dir equal to the detected prisma-client output dir fails naming both directories", () => {
  const resolve = () =>
    resolveClientImportDir({
      outputDir: "/app/generated/client",
      otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" })],
    });

  expect(resolve).toThrow(/\/app\/generated\/client.*\/app\/generated\/client/);
  expect(resolve).toThrow(/`output` must differ from the client output/);
});

test("zero prisma-client generators without clientOutput fails naming the clientOutput option", () => {
  const resolve = () =>
    resolveClientImportDir({
      outputDir: "/app/generated/prisma-factorio",
      otherGenerators: [generatorConfigFixture({ provider: "prisma-client-py", output: "/app/generated/client" })],
    });

  expect(resolve).toThrow(/no generator with provider "prisma-client"/);
  expect(resolve).toThrow(/clientOutput/);
});

test("multiple prisma-client generators without clientOutput fails naming the clientOutput option", () => {
  const resolve = () =>
    resolveClientImportDir({
      outputDir: "/app/generated/prisma-factorio",
      otherGenerators: [
        generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" }),
        generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/other-client" }),
      ],
    });

  expect(resolve).toThrow(/2 generators with provider "prisma-client"/);
  expect(resolve).toThrow(/clientOutput/);
});

test("a matched prisma-client generator without a resolved output fails naming the clientOutput option", () => {
  const resolve = () =>
    resolveClientImportDir({
      outputDir: "/app/generated/prisma-factorio",
      otherGenerators: [generatorConfigFixture({ provider: "prisma-client", output: null })],
    });

  expect(resolve).toThrow(/clientOutput/);
});
