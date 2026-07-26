import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    passWithNoTests: true,
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    environment: "happy-dom",
  },
});
