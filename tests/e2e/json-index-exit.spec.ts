import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const CLI_ENTRY = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const EXIT_TIMEOUT_MS = 60_000;

/**
 * `--json` is one-shot: it prints the session index and must hand the shell
 * back. Nothing else in the suite would notice a process that finishes its
 * work and then keeps the event loop alive on its worker threads and SQLite
 * handles, so the exit itself is the assertion. An isolated empty HOME keeps
 * this hermetic — the hang reproduces with zero sessions to scan.
 */
test("exits after printing the session index as JSON", async () => {
  test.setTimeout(EXIT_TIMEOUT_MS * 2);
  const home = mkdtempSync(join(tmpdir(), "codesesh-json-exit-"));
  try {
    const child = spawn(process.execPath, [CLI_ENTRY, "--json", "--days", "7"], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CONFIG_HOME: join(home, ".config"),
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        CODESESH_LOG_DIR: join(home, "logs"),
        CODESESH_STATE_STORE: "memory",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXIT_TIMEOUT_MS,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(
      signal,
      `--json never exited on its own; it had to be killed. stderr: ${stderr}`,
    ).toBeNull();
    expect(code, `--json exited non-zero. stderr: ${stderr}`).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ sessions: expect.any(Array) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
