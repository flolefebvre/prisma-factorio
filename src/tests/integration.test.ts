import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { initPrismaFactorio } from "../factories/index.ts";
import type { PrismaClient } from "./generated/client/client.ts";
import { Role } from "./generated/client/enums.ts";
import { UserFactoryBase } from "./generated/prisma-factorio/index.ts";
import { createIntegrationClient } from "./integration-db.ts";

class UserFactory extends UserFactoryBase {
  definition() {
    return { email: `user-${randomUUID()}@example.com`, role: Role.MEMBER };
  }
}

const openClients: PrismaClient[] = [];

async function openClient(): Promise<PrismaClient> {
  const client = await createIntegrationClient();
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.$disconnect()));
});

test("create() with a registered client instance persists a row a fresh query reads back", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const created = await UserFactory.new().create();

  const found = await prisma.user.findUnique({ where: { id: created.id } });
  expect(found).not.toBeNull();
  expect(found?.email).toBe(created.email);
  expect(found?.role).toBe(Role.MEMBER);
});

test("a getter registration is resolved on every create(), so swapping the client redirects persistence", async () => {
  const first = await openClient();
  const second = await openClient();
  let current = first;
  initPrismaFactorio({ prisma: () => current });

  const rowInFirst = await UserFactory.new().create();
  current = second;
  const rowInSecond = await UserFactory.new().create();

  expect(await first.user.findUnique({ where: { id: rowInFirst.id } })).not.toBeNull();
  expect(await second.user.findUnique({ where: { id: rowInFirst.id } })).toBeNull();
  expect(await second.user.findUnique({ where: { id: rowInSecond.id } })).not.toBeNull();
  expect(await first.user.findUnique({ where: { id: rowInSecond.id } })).toBeNull();
});
