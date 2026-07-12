import { expect, test } from "vitest";
import { PostFactoryBase } from "./generated/prisma-factorio/Post.ts";
import { TagFactoryBase } from "./generated/prisma-factorio/Tag.ts";
import { UserFactoryBase } from "./generated/prisma-factorio/User.ts";

test("prisma generate emits a factory base class for every fixture model", () => {
  expect(new UserFactoryBase()).toBeInstanceOf(UserFactoryBase);
  expect(new PostFactoryBase()).toBeInstanceOf(PostFactoryBase);
  expect(new TagFactoryBase()).toBeInstanceOf(TagFactoryBase);
});
