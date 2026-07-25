import { defineConfig } from "prisma/config";

// The schema engine refuses to start without a datasource, so `prisma migrate diff` needs one even though it
// only reads the schema files.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: "file::memory:",
  },
});
