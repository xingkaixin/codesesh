import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";

const CLI_ENTRY = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const EXIT_TIMEOUT_MS = 60_000;

async function runJsonCli(home: string, args: string[]) {
  const child = spawn(process.execPath, [CLI_ENTRY, "--json", ...args], {
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
  return { code, signal, stderr, stdout };
}

function readLogEvents(home: string): string[] {
  const logDir = join(home, "logs");
  return readdirSync(logDir)
    .filter((name) => name.endsWith(".log"))
    .flatMap((name) =>
      readFileSync(join(logDir, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { event: string }).event),
    );
}

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
    const { code, signal, stderr, stdout } = await runJsonCli(home, ["--days", "7"]);
    expect(
      signal,
      `--json never exited on its own; it had to be killed. stderr: ${stderr}`,
    ).toBeNull();
    expect(code, `--json exited non-zero. stderr: ${stderr}`).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ sessions: expect.any(Array) });
    expect(readLogEvents(home)).toContain("cli.json_output");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("flushes the fatal event when startup fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "codesesh-json-failure-"));
  try {
    const result = await runJsonCli(home, ["--from", "2026-01-02", "--to", "2026-01-01"]);

    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(readLogEvents(home)).toContain("cli.fatal");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
