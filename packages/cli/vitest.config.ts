import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    passWithNoTests: true,
    include: ["src/**/*.test.ts"],
  },
});
