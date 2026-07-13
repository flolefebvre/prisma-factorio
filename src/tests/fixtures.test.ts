import { expect, expectTypeOf, test, vi } from "vitest";
import { initPrismaFactorio, type StateInput } from "../factories/index.ts";
import type { PrismaClient } from "./generated/client/client.ts";
import { Role } from "./generated/client/enums.ts";
import type { PostCreateInput, TagCreateInput, UserCreateInput, UserModel } from "./generated/client/models.ts";
import { PostFactoryBase } from "./generated/prisma-factorio/Post.ts";
import { TagFactoryBase } from "./generated/prisma-factorio/Tag.ts";
// Imported through the generated barrel; `index.ts` is spelled out because
// nodenext ESM resolution forbids extensionless directory imports.
import {
  initPrismaFactorio as initGeneratedPrismaFactorio,
  UserFactoryBase,
} from "./generated/prisma-factorio/index.ts";

// The generated files import "prisma-factorio/factories", the package's own
// name. Inside this repo that specifier bypasses the published dist build: the
// tsconfig `paths` entry resolves it for tsc and the vitest `resolve.alias`
// entry resolves it at runtime, both to src/factories/index.ts.

class UserFactory extends UserFactoryBase {
  definition() {
    return { email: "ada@example.com", role: Role.ADMIN };
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
      return {
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

  expectTypeOf(chained).toEqualTypeOf<StatefulUserFactory>();
  expectTypeOf(chained.make({ name: "Ada" })).toEqualTypeOf<UserCreateInput>();
  expectTypeOf<Parameters<UserFactoryBase["state"]>[0]>().toEqualTypeOf<StateInput<UserCreateInput>>();
  expectTypeOf<Parameters<UserFactoryBase["make"]>[0]>().toEqualTypeOf<StateInput<UserCreateInput> | undefined>();
  expectTypeOf<Parameters<UserFactoryBase["create"]>[0]>().toEqualTypeOf<StateInput<UserCreateInput> | undefined>();
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
