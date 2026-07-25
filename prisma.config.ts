import { defineConfig } from "prisma/config";

// The schema engine refuses to start without a datasource, so `prisma migrate diff` needs one even though it
// only reads the schema files. Test databases are opened by the driver adapter inside the process that uses
// them; `PrismaConfig` has no adapter key, so no CLI command can reach them.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: "file::memory:",
  },
});
