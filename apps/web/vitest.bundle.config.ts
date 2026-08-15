import { defineConfig } from "vitest/config";

// Runs against dist/ and therefore depends on a fresh production build; kept
// out of the default unit suite so `vitest run` needs no build and cannot
// report a false green against a stale bundle.
export default defineConfig({
  test: {
    name: "web-bundle",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
