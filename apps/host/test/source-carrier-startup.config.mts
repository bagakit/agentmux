import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/host/test/source-carrier-startup.test.ts"],
    environment: "node",
    globalSetup: [],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 190000,
    hookTimeout: 20000,
  },
});
