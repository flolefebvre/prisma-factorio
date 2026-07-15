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

test("count() with sequence() persists n rows, cycling the sequenced field and re-evaluating the definition per row", async () => {
  const prisma = await openClient();
  initPrismaFactorio({ prisma });

  const created = await UserFactory.new().count(3).sequence({ role: Role.ADMIN }, { role: Role.MEMBER }).create();

  // create() returns the rows in creation order, so the cycle reads off directly.
  expect(created.map((row) => row.role)).toEqual([Role.ADMIN, Role.MEMBER, Role.ADMIN]);
  // Distinct emails prove definition() re-ran for each instance.
  expect(new Set(created.map((row) => row.email)).size).toBe(3);

  // The rows really reached the database. Matched by id set, not position: the
  // id is a random uuid, so a re-query cannot recover creation order.
  const persisted = await prisma.user.findMany();
  expect(persisted).toHaveLength(3);
  expect(new Set(persisted.map((row) => row.id))).toEqual(new Set(created.map((row) => row.id)));
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
