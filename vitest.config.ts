import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/contract",
      "apps/web",
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          exclude: ["scripts/rust/**"],
        },
      },
    ],
  },
});
