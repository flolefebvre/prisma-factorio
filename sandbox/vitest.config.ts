import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["sandbox/**/*.test.ts"],
    // The suite shares one sqlite file; parallel files would interleave.
    fileParallelism: false,
  },
});
