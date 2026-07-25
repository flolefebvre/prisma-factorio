import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "sandbox/prisma/schema.prisma",
  migrations: {
    path: "sandbox/prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
