import path from "node:path";
import { defineConfig } from "prisma/config";

const root = import.meta.dirname;

export default defineConfig({
  schema: path.join(root, "prisma/schema.prisma"),
  datasource: {
    url: `file:${path.join(root, "dev.db")}`,
  },
});
