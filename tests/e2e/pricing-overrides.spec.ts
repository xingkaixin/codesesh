import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "playwright/test";
import { nativeBinary } from "../../scripts/lib/native-command.mjs";
import { monitorBrowserErrors } from "./test-fixtures.js";

const UNMATCHED_MODEL = "acme/e2e-unmatched-v1";
const SERVER_READY_TIMEOUT_MS = 30_000;

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve ephemeral TCP port");
  }
  return address.port;
}

function buildIsolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const strippedPrefixes = ["CODESESH_"];
  const overriddenKeys = new Set([
    "AGY_CONVERSATIONS_DIR",
    "APPDATA",
    "CHERRYSTUDIO_USER_DATA_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "CURSOR_DATA_PATH",
    "DEEPCHAT_USER_DATA_DIR",
    "DSH_HOME",
    "FACTORY_HOME_OVERRIDE",
    "GEMINI_CLI_HOME",
    "GROK_HOME",
    "HOME",
    "KIMI_CODE_HOME",
    "KIMI_SHARE_DIR",
    "LOCALAPPDATA",
    "OPENCODE_DB",
    "PI_CODING_AGENT_DIR",
    "QODERCN_CONFIG_DIR",
    "QODER_CONFIG_DIR",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (strippedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (overriddenKeys.has(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CODEX_HOME: join(home, ".codex"),
    CODESESH_LOG_DIR: join(home, ".codesesh", "logs"),
    CODESESH_STATE_DIR: join(home, ".codesesh"),
  };
}

function seedIsolatedHome(home: string): void {
  const projectDir = join(home, "project");
  const sessionDir = join(home, ".codex", "sessions", "2026", "04", "20");
  const codeseshDir = join(home, ".codesesh");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(codeseshDir, { recursive: true });

  // Seed fresh official cache entries so startup never initiates remote downloads.
  writeFileSync(
    join(codeseshDir, "models-dev-pricing.json"),
    JSON.stringify({
      timestamp: Date.now() - 1_000,
      data: {
        "claude-sonnet-4-5": {
          inputCostPerToken: 0.000003,
          outputCostPerToken: 0.000015,
          cacheCreateCostPerToken: 0.00000375,
          cacheReadCostPerToken: 0.0000003,
        },
      },
    }),
  );

  const lines = [
    JSON.stringify({
      timestamp: "2026-04-20T10:00:00Z",
      type: "session_meta",
      payload: { cwd: projectDir, model: UNMATCHED_MODEL },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Calculate token cost for custom model" }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        model: UNMATCHED_MODEL,
        content: [{ type: "output_text", text: "Usage recorded." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-20T10:00:03Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
          total_token_usage: {
            total_tokens: 1_500_000,
            input_tokens: 1_000_000,
            output_tokens: 500_000,
          },
        },
      },
    }),
  ];

  writeFileSync(
    join(sessionDir, "rollout-2026-04-20T10-00-00-019daaaa-bbbb-7bbb-8bbb-aaaaaaaaaaaa.jsonl"),
    `${lines.join("\n")}\n`,
  );
}

async function waitForUnmatchedSeed(origin: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/pricing/overview?days=0`);
      if (response.ok) {
        const body = (await response.json()) as {
          unmatchedModels?: Array<{ modelKey?: string }>;
        };
        if (body.unmatchedModels?.some((item) => item.modelKey === UNMATCHED_MODEL)) {
          return;
        }
      }
    } catch {
      // Server still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated server at ${origin}`);
}

test("configures a model pricing override and updates dashboard API value live", async ({
  page,
}) => {
  const errors = monitorBrowserErrors(page);
  const home = mkdtempSync(join(tmpdir(), "codesesh-e2e-pricing-"));
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  seedIsolatedHome(home);

  const child = spawn(
    nativeBinary,
    ["--host", "127.0.0.1", "--port", String(port), "--agent", "codex", "--days", "0", "--noOpen"],
    {
      env: buildIsolatedEnv(home),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const childExit = once(child, "exit");

  try {
    await waitForUnmatchedSeed(origin);

    await page.goto(origin);
    const dashboard = page.getByTestId("dashboard");
    const apiValueCard = dashboard.locator("section").filter({ hasText: /^API value/ });
    await expect(apiValueCard.locator("p").first()).toHaveText("$0.00");
    await expect(apiValueCard.getByRole("button", { name: "1 unmatched" })).toBeVisible();

    const modelCard = page.getByRole("region", { name: "By model" });
    const modelRow = modelCard.getByRole("row", { name: new RegExp(UNMATCHED_MODEL) });
    await expect(modelRow).toContainText("1.5M");
    await expect(modelRow).toContainText("—");

    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });

    await apiValueCard.getByRole("button", { name: "1 unmatched" }).click();
    const drawer = page.getByRole("dialog", { name: "Model pricing" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("tab", { name: /Unmatched/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer.getByText(UNMATCHED_MODEL)).toBeVisible();
    await expect(drawer.getByText("Codex")).toBeVisible();

    await drawer.getByRole("button", { name: "Set price" }).click();

    const searchInput = drawer.getByPlaceholder("Search official models");
    await searchInput.fill("claude-sonnet-4-5");
    await expect(drawer.getByRole("button", { name: /claude-sonnet-4-5/ }).first()).toBeVisible();

    await drawer.getByRole("radio", { name: "Manual USD / 1M" }).click();
    await drawer.getByLabel("Input (USD / 1M)").fill("2");
    await drawer.getByLabel("Output (USD / 1M)").fill("10");
    await drawer.getByRole("button", { name: "Save override" }).click();

    await expect(drawer.getByText("All models in range are priced")).toBeVisible();
    await drawer.getByRole("tab", { name: /Overrides/ }).click();
    await expect(drawer.getByText(UNMATCHED_MODEL)).toBeVisible();
    await expect(drawer.getByText("Manual USD / 1M")).toBeVisible();

    await drawer.getByRole("button", { name: "Close model pricing" }).click();
    await expect(drawer).toBeHidden();

    // Dashboard metrics and breakdown tables update in place without a full reload.
    await expect(apiValueCard.locator("p").first()).toHaveText("$7.00");
    await expect(apiValueCard.getByText("Estimated")).toBeVisible();
    await expect(apiValueCard.getByRole("button", { name: "1 unmatched" })).toHaveCount(0);
    await expect(modelRow).toContainText("$7.00");
    const agentCard = page.getByRole("region", { name: "By agent" });
    await expect(agentCard.getByRole("row", { name: /Codex/ })).toContainText("$7.00");
    expect(mainFrameNavigations).toBe(0);

    // Override survives a full reload from SQLite state.db.
    await page.reload();
    await expect(apiValueCard.locator("p").first()).toHaveText("$7.00");
    await expect(modelRow).toContainText("$7.00");

    expect(errors, `unexpected browser errors (stderr: ${stderr})`).toEqual([]);
  } finally {
    await page.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        childExit,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 3_000);
        }),
      ]);
    }
    rmSync(home, { recursive: true, force: true });
  }
});
