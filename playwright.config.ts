import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "playwright/test";

const port = Number(process.env.CODESESH_E2E_PORT ?? 4387);
const e2eHome = mkdtempSync(join(tmpdir(), "codesesh-e2e-home-"));
const fixtureRoot = resolve("tests/e2e/fixtures");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm build && node packages/cli/dist/index.js --port ${port} --agent claudecode --days 0 --noOpen --cache false`,
    url: `http://127.0.0.1:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      HOME: e2eHome,
      USERPROFILE: e2eHome,
      XDG_DATA_HOME: join(e2eHome, ".local", "share"),
      XDG_CONFIG_HOME: join(e2eHome, ".config"),
      APPDATA: join(e2eHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(e2eHome, "AppData", "Local"),
      CODESESH_STATE_STORE: "memory",
      CODESESH_STATE_DIR: join(e2eHome, "state"),
      CLAUDE_CONFIG_DIR: join(fixtureRoot, "claude"),
      CODEX_HOME: join(e2eHome, ".codex"),
      KIMI_SHARE_DIR: join(e2eHome, ".kimi"),
      CURSOR_DATA_PATH: join(e2eHome, "cursor"),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
