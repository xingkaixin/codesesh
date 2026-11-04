import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    name: "web",
    passWithNoTests: true,
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
  },
});
