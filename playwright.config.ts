import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "playwright/test";

const FIXTURE_PROJECT_DIR_TOKEN = "__E2E_PROJECT_DIR__";
const E2E_HOME_ENV = "CODESESH_PLAYWRIGHT_HOME";
const port = Number(process.env.CODESESH_E2E_PORT ?? 4387);
const wwwPort = Number(process.env.CODESESH_WWW_E2E_PORT ?? 4388);
const inheritedE2eHome = process.env[E2E_HOME_ENV];
const e2eHome = inheritedE2eHome ?? mkdtempSync(join(tmpdir(), "codesesh-e2e-home-"));
const fixtureTemplateRoot = resolve("tests/e2e/fixtures");
const fixtureRoot = join(e2eHome, "fixtures");
const e2eProjectDir = join(e2eHome, "codesesh-e2e");
const fixtureSessionPath = join(fixtureRoot, "claude/projects/codesesh-e2e/e2e-dashboard.jsonl");

if (!inheritedE2eHome) {
  process.env[E2E_HOME_ENV] = e2eHome;
  cpSync(fixtureTemplateRoot, fixtureRoot, { recursive: true });
  process.once("exit", () => rmSync(e2eHome, { recursive: true, force: true }));

  mkdirSync(e2eProjectDir, { recursive: true });
  const fixtureSessionTemplate = readFileSync(fixtureSessionPath, "utf8");
  if (!fixtureSessionTemplate.includes(FIXTURE_PROJECT_DIR_TOKEN)) {
    throw new Error(`E2E fixture is missing ${FIXTURE_PROJECT_DIR_TOKEN}`);
  }
  writeFileSync(
    fixtureSessionPath,
    fixtureSessionTemplate.replaceAll(FIXTURE_PROJECT_DIR_TOKEN, e2eProjectDir),
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
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
    {
      command: `pnpm --filter @codesesh/www dev --host 127.0.0.1 --port ${wwwPort}`,
      url: `http://127.0.0.1:${wwwPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "web-chromium",
      testMatch: ["browsing.spec.ts", "live-refresh.spec.ts"],
      metadata: { fixtureSessionPath },
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` },
    },
    {
      name: "www-chromium",
      testMatch: "www.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${wwwPort}` },
    },
  ],
});
