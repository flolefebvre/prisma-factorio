import { expect, expectTypeOf, test, vi } from "vitest";
import { FactoryCycleError, initPrismaFactorio, type StateInput } from "../factories/index.ts";
import type { PrismaClient } from "./generated/client/client.ts";
import { Role } from "./generated/client/enums.ts";
import type {
  PostCreateInput,
  PostModel,
  TagCreateInput,
  UserCreateInput,
  UserModel,
} from "./generated/client/models.ts";
import { PostFactoryBase } from "./generated/prisma-factorio/Post.ts";
import { TagFactoryBase } from "./generated/prisma-factorio/Tag.ts";
// Imported through the generated barrel; `index.ts` is spelled out because
// nodenext ESM resolution forbids extensionless directory imports.
import {
  ChickenFactoryBase,
  EggFactoryBase,
  initPrismaFactorio as initGeneratedPrismaFactorio,
  registerFactories as registerGeneratedFactories,
  UserFactoryBase,
} from "./generated/prisma-factorio/index.ts";

// Every required scalar of the fixture Post, shared so factory-as-value tests
// vary only the relation field.
const postScalars = {
  title: "Typed factories",
  wordCount: 1200,
  views: 10n,
  rating: 4.5,
  price: "19.99",
  isPublished: true,
  metadata: { tags: ["intro"] },
  thumbnail: new Uint8Array([1, 2, 3]),
  reviewedAt: new Date("2026-01-01T00:00:00Z"),
};

// The generated files import "prisma-factorio/factories", the package's own
// name. Inside this repo that specifier bypasses the published dist build: the
// tsconfig `paths` entry resolves it for tsc and the vitest `resolve.alias`
// entry resolves it at runtime, both to src/factories/index.ts.

class UserFactory extends UserFactoryBase {
  definition() {
    return { email: "ada@example.com", role: Role.ADMIN };
  }

  admin() {
    return this.state({ role: Role.ADMIN });
  }
}

// A Post whose required author belongsTo is covered by a factory-as-value, so
// the magic `forAuthor` short forms have a default factory to build on.
class PostFactory extends PostFactoryBase {
  definition() {
    return { ...postScalars, author: UserFactory.new() };
  }
}

test("extending a generated base with a definition() makes the expected object", () => {
  expect(UserFactory.new().make()).toEqual({ email: "ada@example.com", role: Role.ADMIN });
});

test("definition() is re-evaluated on every make() call", () => {
  let counter = 0;
  class SequencedUserFactory extends UserFactoryBase {
    definition() {
      counter += 1;
      return { email: `user-${String(counter)}@example.com`, role: Role.MEMBER };
    }
  }

  const factory = SequencedUserFactory.new();

  expect(factory.make().email).toBe("user-1@example.com");
  expect(factory.make().email).toBe("user-2@example.com");
});

test("every scalar type of the fixture matrix is accepted in a definition()", () => {
  class PostFactory extends PostFactoryBase {
    definition() {
      return { ...postScalars, author: UserFactory.new() };
    }
  }

  const post = PostFactory.new().make();

  expect(post.wordCount).toBe(1200);
  expect(post.views).toBe(10n);
  expect(post.thumbnail).toEqual(new Uint8Array([1, 2, 3]));
  expect(post.reviewedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
});

test("a model whose fields all have defaults or are optional accepts an empty definition()", () => {
  class TagFactory extends TagFactoryBase {
    definition() {
      return {};
    }
  }

  expect(TagFactory.new().make()).toEqual({});
});

test("fields with @default or @updatedAt stay optional in definition() but can be provided", () => {
  class ExplicitUserFactory extends UserFactoryBase {
    definition() {
      return {
        id: "00000000-0000-0000-0000-000000000001",
        email: "grace@example.com",
        name: "Grace Hopper",
        role: Role.MEMBER,
        backupRole: Role.ADMIN,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }
  }

  expect(ExplicitUserFactory.new().make().id).toBe("00000000-0000-0000-0000-000000000001");
});

test("make() returns the exact CreateInput type of the client for every model", () => {
  expectTypeOf(UserFactory.new().make()).toEqualTypeOf<UserCreateInput>();
  expectTypeOf<UserFactoryBase["make"]>().returns.toEqualTypeOf<UserCreateInput>();
  expectTypeOf<PostFactoryBase["make"]>().returns.toEqualTypeOf<PostCreateInput>();
  expectTypeOf<TagFactoryBase["make"]>().returns.toEqualTypeOf<TagCreateInput>();
});

test("omitting a required field in definition() is a compile error", () => {
  class MissingRoleUserFactory extends UserFactoryBase {
    // @ts-expect-error definition() misses the required field `role`
    definition() {
      return { email: "ada@example.com" };
    }
  }

  expect(MissingRoleUserFactory).toBeDefined();
});

test("create() persists through the delegate named after the model and resolves the persisted row", async () => {
  const persistedUser: UserModel = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "ada@example.com",
    name: null,
    role: "ADMIN",
    backupRole: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const create = vi.fn(() => Promise.resolve(persistedUser));
  initPrismaFactorio({ prisma: { user: { create } } });

  const created = await UserFactory.new().create();

  expect(create).toHaveBeenCalledExactlyOnceWith({ data: { email: "ada@example.com", role: Role.ADMIN } });
  expect(created).toBe(persistedUser);
});

test("create() resolves with the row typed as the client's Model type", () => {
  expectTypeOf<ReturnType<UserFactory["create"]>>().resolves.toEqualTypeOf<UserModel>();
  expectTypeOf<UserFactoryBase["create"]>().returns.toEqualTypeOf<Promise<UserModel>>();
});

test("the generated initPrismaFactorio only accepts the client generated for this schema", () => {
  expectTypeOf(initGeneratedPrismaFactorio)
    .parameter(0)
    .toEqualTypeOf<{ prisma: PrismaClient | (() => PrismaClient) }>();

  const wrongClient = () => {
    // @ts-expect-error an object that is not this schema's PrismaClient is rejected
    initGeneratedPrismaFactorio({ prisma: {} });
  };

  expect(wrongClient).toBeDefined();
});

test("the generated registerFactories accepts this schema's concrete factories and rejects unknown model keys", () => {
  registerGeneratedFactories({ User: UserFactory });

  const unknownModelKey = () => {
    // @ts-expect-error `Wombat` is not a model of this schema
    registerGeneratedFactories({ Wombat: UserFactory });
  };
  const wrongModelFactory = () => {
    // @ts-expect-error a PostFactory is not a UserFactoryBase constructor
    registerGeneratedFactories({ User: PostFactoryBase });
  };

  expect(unknownModelKey).toBeDefined();
  expect(wrongModelFactory).toBeDefined();
});

class StatefulUserFactory extends UserFactoryBase {
  definition() {
    return { email: "ada@example.com", role: Role.MEMBER };
  }

  admin() {
    return this.state({ role: Role.ADMIN });
  }

  named(name: string) {
    return this.state({ name });
  }

  emailFromName() {
    return this.state((attrs) => ({ email: `${(attrs.name ?? "anonymous").toLowerCase()}@example.com` }));
  }
}

test("named, parameterized, closure, and inline states chain in any order and combination", () => {
  const closureLast = StatefulUserFactory.new().admin().named("Grace").emailFromName().make();
  const inlineBetweenNamed = StatefulUserFactory.new().named("Grace").state({ backupRole: Role.MEMBER }).admin().make();

  expect(closureLast).toEqual({ email: "grace@example.com", role: Role.ADMIN, name: "Grace" });
  expect(inlineBetweenNamed).toEqual({
    email: "ada@example.com",
    role: Role.ADMIN,
    name: "Grace",
    backupRole: Role.MEMBER,
  });
});

test("state() keeps the concrete factory type and the pipeline keeps the exact client types", () => {
  const chained = StatefulUserFactory.new().admin().state({ name: "Ada" });

  // A relation back-reference (User.posts) widens the definition type, so the
  // pipeline's inputs are StateInput of that definition, while make() still
  // returns the exact client CreateInput.
  type UserDefinition = ReturnType<UserFactoryBase["definition"]>;
  expectTypeOf(chained).toEqualTypeOf<StatefulUserFactory>();
  expectTypeOf(chained.make({ name: "Ada" })).toEqualTypeOf<UserCreateInput>();
  // state() is generic over the parent type a child closure may annotate, so its
  // parameter is a StateInput whose parent defaults to the free `unknown`; make()
  // and create() overrides run at the top level and stay non-generic.
  expectTypeOf<Parameters<UserFactoryBase["state"]>[0]>().toEqualTypeOf<StateInput<UserDefinition, unknown>>();
  expectTypeOf<Parameters<UserFactoryBase["make"]>[0]>().toEqualTypeOf<StateInput<UserDefinition> | undefined>();
  expectTypeOf<Parameters<UserFactoryBase["create"]>[0]>().toEqualTypeOf<StateInput<UserDefinition> | undefined>();
});

test("unknown fields in a state partial or overrides argument are compile errors", () => {
  const factory = StatefulUserFactory.new();

  const unknownInState = () => {
    // @ts-expect-error `nickname` is not a field of UserCreateInput
    return factory.state({ nickname: "ada" });
  };
  const unknownInMakeOverrides = () => {
    // @ts-expect-error `nickname` is not a field of UserCreateInput
    return factory.make({ nickname: "ada" });
  };
  const unknownInCreateOverrides = () => {
    // @ts-expect-error `nickname` is not a field of UserCreateInput
    return factory.create({ nickname: "ada" });
  };

  expect(unknownInState).toBeDefined();
  expect(unknownInMakeOverrides).toBeDefined();
  expect(unknownInCreateOverrides).toBeDefined();
});

test("the generated base itself cannot start a chain because it has no definition()", () => {
  // @ts-expect-error an abstract factory base cannot be instantiated
  const chain = () => UserFactoryBase.new();

  expect(chain).toBeDefined();
});

test("a required belongsTo covered by a factory-as-value satisfies the definition coverage check", () => {
  class AuthoredPostFactory extends PostFactoryBase {
    definition() {
      return { ...postScalars, author: UserFactory.new() };
    }
  }

  const input = AuthoredPostFactory.new().make();

  expect(input.author).toEqual({ create: { email: "ada@example.com", role: Role.ADMIN } });
  expectTypeOf(input).toEqualTypeOf<PostCreateInput>();
});

test("omitting the required belongsTo relation in a Post definition is a compile error", () => {
  class MissingAuthorPostFactory extends PostFactoryBase {
    // @ts-expect-error definition() misses the required relation `author`
    definition() {
      return { ...postScalars };
    }
  }

  expect(MissingAuthorPostFactory).toBeDefined();
});

test("the lazy () => factory form resolves identically to the eager form on a generated factory", () => {
  class EagerPostFactory extends PostFactoryBase {
    definition() {
      return { ...postScalars, author: UserFactory.new() };
    }
  }
  class LazyPostFactory extends PostFactoryBase {
    definition() {
      return { ...postScalars, author: () => UserFactory.new() };
    }
  }

  expect(LazyPostFactory.new().make().author).toEqual(EagerPostFactory.new().make().author);
});

test("a relation supplied through overrides short-circuits the generated factory-as-value", () => {
  class ThrowingUserFactory extends UserFactoryBase {
    definition(): { email: string; role: Role } {
      throw new Error("the nested factory must not be evaluated when the relation is supplied");
    }
  }
  class PostWithThrowingAuthor extends PostFactoryBase {
    definition() {
      return { ...postScalars, author: ThrowingUserFactory.new() };
    }
  }

  const input = PostWithThrowingAuthor.new().make({ author: { connect: { id: "u-1" } } });

  expect(input.author).toEqual({ connect: { id: "u-1" } });
});

test("a definition-level cycle between two generated factories throws FactoryCycleError naming the cycle", () => {
  class ChickenFactory extends ChickenFactoryBase {
    definition() {
      return { name: "Hen", egg: EggFactory.new() };
    }
  }
  class EggFactory extends EggFactoryBase {
    definition() {
      return { code: "E-1", chicken: ChickenFactory.new() };
    }
  }

  expect(() => ChickenFactory.new().make()).toThrow(FactoryCycleError);
  expect(() => ChickenFactory.new().make()).toThrow(/ChickenFactory.*EggFactory.*ChickenFactory/);
});

test("forAuthor(overrides) builds on the definition's default author factory", () => {
  const input = PostFactory.new().forAuthor({ name: "Jessica Archer" }).make();

  expect(input.author).toEqual({ create: { email: "ada@example.com", role: Role.ADMIN, name: "Jessica Archer" } });
});

test("forAuthor(existingRow) connects the row by id and drops the default factory", () => {
  const existing: UserModel = {
    id: "00000000-0000-0000-0000-000000000009",
    email: "grace@example.com",
    name: "Grace",
    role: Role.MEMBER,
    backupRole: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  const input = PostFactory.new().forAuthor(existing).make();

  expect(input.author).toEqual({ connect: { id: existing.id } });
});

test("forAuthor(factory) nests a create from the configured factory", () => {
  const input = PostFactory.new()
    .forAuthor(UserFactory.new().admin().state({ name: "Ada" }))
    .make();

  expect(input.author).toEqual({ create: { email: "ada@example.com", role: Role.ADMIN, name: "Ada" } });
});

test("a second same-model relation gets its own forReviewer method, distinct from forAuthor", () => {
  const input = PostFactory.new()
    .forAuthor({ name: "Author" })
    .forReviewer({
      id: "reviewer-1",
      email: "r",
      name: null,
      role: Role.MEMBER,
      backupRole: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    .make();

  expect(input.author).toEqual({ create: { email: "ada@example.com", role: Role.ADMIN, name: "Author" } });
  expect(input.reviewer).toEqual({ connect: { id: "reviewer-1" } });
});

test("forAuthor grows create()'s return type with the built relation; the bare chain stays PostModel", () => {
  expectTypeOf(PostFactory.new().create()).resolves.toEqualTypeOf<PostModel>();
  expectTypeOf(PostFactory.new().forAuthor({ name: "X" }).create()).resolves.toEqualTypeOf<
    PostModel & { author: UserModel }
  >();
  expectTypeOf(PostFactory.new().forAuthor({ name: "X" }).forReviewer({ name: "Y" }).create()).resolves.toEqualTypeOf<
    PostModel & { author: UserModel } & { reviewer: UserModel }
  >();
});

test("hasPosts(n) builds n children from the registered Post factory, dropping each child's author back-reference", () => {
  registerGeneratedFactories({ Post: PostFactory });

  const input = UserFactory.new().hasPosts(2).make();

  const created = (input.posts as { create: Record<string, unknown>[] }).create;
  expect(created).toHaveLength(2);
  // The author factory-as-value from PostFactory's definition is dropped: the
  // nesting under user.posts already links them, so no second user is created.
  expect(created[0]).toEqual(postScalars);
  expect(created[0]).not.toHaveProperty("author");
});

test("hasPosts(n, overrides) applies uniform overrides to every child", () => {
  registerGeneratedFactories({ Post: PostFactory });

  const input = UserFactory.new().hasPosts(3, { title: "Uniform" }).make();

  const created = (input.posts as { create: { title: string }[] }).create;
  expect(created.map((post) => post.title)).toEqual(["Uniform", "Uniform", "Uniform"]);
});

test("hasPosts grows create()'s return type, composing with the child chain's own relations", () => {
  expectTypeOf(UserFactory.new().hasPosts(2).create()).resolves.toEqualTypeOf<UserModel & { posts: PostModel[] }>();
  expectTypeOf(
    UserFactory.new()
      .hasPosts(PostFactory.new().forAuthor({ name: "X" }))
      .create(),
  ).resolves.toEqualTypeOf<UserModel & { posts: (PostModel & { author: UserModel })[] }>();
});

test("passing a count alongside a factory instance is a compile error", () => {
  const badCall = () => {
    // @ts-expect-error a count cannot accompany a factory instance — the factory carries its own count()
    UserFactory.new().hasPosts(PostFactory.new(), 3);
  };

  expect(badCall).toBeDefined();
});
