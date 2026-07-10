import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    passWithNoTests: true,
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
