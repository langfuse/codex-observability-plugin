import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["plugins/tracing/test/e2e/**/*.e2e.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
