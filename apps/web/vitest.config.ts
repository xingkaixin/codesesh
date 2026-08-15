import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    passWithNoTests: true,
    // The bundle-budget test lives in vitest.bundle.config.ts: it needs a
    // fresh production dist, which the unit suite must not depend on.
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
  },
});
