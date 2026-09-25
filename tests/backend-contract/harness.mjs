import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const SESSION_ID = "019fdefe-bb8d-76f3-b988-770e6cc6a30d";
export const REFERENCE = { agentName: "codex", sessionId: SESSION_ID };
export const DETAIL_PATH = `/api/sessions/codex/${SESSION_ID}`;

export function backendCommand() {
  const configured = process.env.CODESESH_BACKEND_COMMAND;
  const command = configured
    ? JSON.parse(configured)
    : [process.execPath, resolve("packages/cli/dist/index.js")];
  assert.ok(
    Array.isArray(command) &&
      command.length > 0 &&
      command.every((part) => typeof part === "string" && part.length > 0),
  );
  return command;
}

function writeRecords(path, records) {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  utimesSync(path, new Date("2026-09-01T10:00:03Z"), new Date("2026-09-01T10:00:03Z"));
}

export function createFixture() {
  const temporary = mkdtempSync(join(tmpdir(), "codesesh-backend-"));
  const root = process.platform === "win32" ? realpathSync.native(temporary) : temporary;
  const project = join(root, "project");
  const codex = join(root, "codex");
  const sessions = join(codex, "sessions", "2026", "09", "01");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const source = join(sessions, `rollout-2026-09-01T10-00-00-${SESSION_ID}.jsonl`);
  writeRecords(source, [
    {
      timestamp: "2026-09-01T10:00:00Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: project, model: "migration-fixture" },
    },
    {
      timestamp: "2026-09-01T10:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Migration fixture 中文 🔎" }],
      },
    },
    {
      timestamp: "2026-09-01T10:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        model: "migration-fixture",
        content: [
          { type: "output_text", text: "A deterministic searchable reply: migration-needle." },
        ],
      },
    },
  ]);
  const cache = join(root, ".cache", "codesesh");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    join(cache, "models-dev-pricing.json"),
    JSON.stringify({
      timestamp: Date.now(),
      data: { "migration-fixture": { inputCostPerToken: 0, outputCostPerToken: 0 } },
    }),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODESESH_") || key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    CODESESH_STATE_DIR: join(root, "state"),
    CODESESH_LOG_DIR: join(root, "logs"),
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CURSOR_DATA_PATH: join(root, "cursor"),
    KIMI_SHARE_DIR: join(root, "kimi"),
    KIMI_CODE_HOME: join(root, "kimi-code"),
    PI_HOME: join(root, "pi"),
    GROK_HOME: join(root, "grok"),
    DSH_HOME: join(root, "dsh"),
    OPENCODE_DB: join(root, "opencode.db"),
    DEEPCHAT_USER_DATA_DIR: join(root, "deepchat"),
    CHERRYSTUDIO_USER_DATA_DIR: join(root, "cherry"),
    MINIMAX_DATA_DIR: join(root, "minimax"),
    MAVIS_DATA_DIR: join(root, "minimax"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TZ: "UTC",
  });
  return {
    root,
    project,
    source,
    env,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function appendReply(fixture) {
  appendFileSync(
    fixture.source,
    `${JSON.stringify({ timestamp: "2026-09-01T10:00:04Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Live appended migration message" }] } })}\n`,
  );
}

export async function waitFor(read, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

export function launch(fixture, args, command = backendCommand()) {
  const child = spawn(command[0], [...command.slice(1), ...args], {
    cwd: fixture.project,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  completed.catch(() => {});
  return { child, completed, output: () => ({ stdout, stderr }) };
}

export async function stop(process) {
  if (process.child.exitCode !== null || process.child.signalCode !== null)
    return process.completed;
  process.child.kill("SIGTERM");
  const timeout = setTimeout(() => process.child.kill("SIGKILL"), 5_000);
  try {
    return await process.completed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runCli(fixture, args, command) {
  const process = launch(fixture, args, command);
  const timeout = setTimeout(() => process.child.kill("SIGKILL"), 30_000);
  try {
    return await process.completed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startServer(fixture, command) {
  const process = launch(
    fixture,
    ["--agent", "codex", "--days", "0", "--noOpen", "--host", "127.0.0.1", "--port", "0"],
    command,
  );
  try {
    const startup = await waitFor(() => {
      assert.equal(process.child.exitCode, null, JSON.stringify(process.output()));
      return [...process.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((match) => new URL(match[0]))
        .find((url) => url.searchParams.has("access_token"));
    }, "server startup URL");
    startup.hostname = "127.0.0.1";
    const request = (path, options = {}) =>
      fetch(new URL(path, startup.origin), {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${startup.searchParams.get("access_token")}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    await waitFor(async () => {
      const response = await request("/api/status");
      const status = await response.json();
      return !status.active && status.completedAgents.includes("codex");
    }, "initial scan completion");
    return { ...process, request, origin: startup.origin };
  } catch (error) {
    await stop(process);
    throw new Error(`${error.message}\n${JSON.stringify(process.output())}`, { cause: error });
  }
}

export async function readJson(server, path, options, expectedStatus = 200) {
  const response = await server.request(path, options);
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

export async function openEvents(server) {
  const controller = new AbortController();
  const response = await server.request("/api/events", { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const reading = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let separator;
      while ((separator = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        const type = frame.match(/^event: ?(.+)$/m)?.[1];
        const data = frame.match(/^data: ?(.+)$/m)?.[1];
        if (type && data) events.push({ type, data: JSON.parse(data) });
      }
    }
  })();
  reading.catch(() => {});
  await waitFor(() => events.some((event) => event.type === "scan-status"), "initial SSE status");
  return {
    events,
    async close() {
      controller.abort();
      await reading.catch(() => {});
    },
  };
}
