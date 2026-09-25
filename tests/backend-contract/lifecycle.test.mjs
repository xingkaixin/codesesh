import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFixture,
  DETAIL_PATH,
  launch,
  openEvents,
  readJson,
  REFERENCE,
  runCli,
  startServer,
  stop,
  waitFor,
} from "./harness.mjs";

test(
  "SIGTERM exits successfully while an SSE client remains connected",
  { timeout: 30_000, skip: process.platform === "win32" },
  async () => {
    const fixture = createFixture();
    let server;
    let events;
    try {
      server = await startServer(fixture);
      events = await openEvents(server);
      server.child.kill("SIGTERM");
      await waitFor(() => server.child.exitCode !== null, "shutdown with live SSE", 7_000);
      const result = await server.completed;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
    } finally {
      await events?.close();
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "a damaged scan cache preserves CLI output and HTTP availability",
  { timeout: 60_000 },
  async () => {
    const fixture = createFixture();
    const cache = join(fixture.root, ".cache", "codesesh", "codesesh.db");
    const damaged = "not a sqlite database";
    let server;
    try {
      writeFileSync(cache, damaged);
      const result = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"]);
      assert.equal(result.code, 0, result.stderr);
      const index = JSON.parse(result.stdout);
      assert.deepEqual(
        index.sessions.map((session) => session.reference),
        [REFERENCE],
      );
      assert.equal(readFileSync(cache, "utf8"), damaged);
      server = await startServer(fixture);
      const sessions = await readJson(server, "/api/sessions");
      assert.ok(Array.isArray(sessions.sessions));
      assert.equal(readFileSync(cache, "utf8"), damaged);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "a damaged user state database leaves session browsing available",
  { timeout: 35_000 },
  async () => {
    const fixture = createFixture();
    const directory = fixture.env.CODESESH_STATE_DIR;
    const state = join(directory, "state.db");
    const damaged = "not a sqlite database";
    let server;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(state, damaged);
      server = await startServer(fixture);
      const sessions = await readJson(server, "/api/sessions");
      assert.deepEqual(
        sessions.sessions.map((session) => session.reference),
        [REFERENCE],
      );
      const detail = await readJson(server, DETAIL_PATH);
      assert.equal(detail.messages.length, 2);
      const response = await server.request("/api/bookmarks");
      await response.arrayBuffer();
      assert.ok(
        response.status >= 500 && response.status < 600,
        `bookmarks returned ${response.status}`,
      );
      assert.equal(readFileSync(state, "utf8"), damaged);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "failed source scans do not emit a successful CLI JSON document",
  { timeout: 35_000 },
  async () => {
    const fixture = createFixture();
    try {
      writeFileSync(fixture.env.OPENCODE_DB, "not a sqlite database");
      const result = await runCli(fixture, ["--json", "--agent", "opencode", "--days", "0"]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /opencode/i);
    } finally {
      fixture.dispose();
    }
  },
);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function proxyRequest(port, token, forwarded) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/agents",
        headers: {
          Host: "codesesh.example.com",
          Authorization: `Bearer ${token}`,
          ...(forwarded ? { "X-Forwarded-Proto": forwarded } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", reject);
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("proxy request timed out")));
    request.on("error", reject);
    request.end();
  });
}

test(
  "trusted proxies can preserve the public Host while enforcing TLS",
  { timeout: 35_000 },
  async () => {
    const fixture = createFixture();
    const port = await unusedPort();
    let server;
    try {
      server = launch(fixture, [
        "--agent",
        "codex",
        "--days",
        "0",
        "--noOpen",
        "--port",
        String(port),
        "--remote-access",
        "--trust-proxy",
        "--public-url",
        "https://codesesh.example.com",
      ]);
      const startup = await waitFor(() => {
        assert.equal(server.child.exitCode, null, JSON.stringify(server.output()));
        return [...server.output().stdout.matchAll(/https?:\/\/\S+/g)]
          .map((match) => new URL(match[0]))
          .find((url) => url.searchParams.has("access_token"));
      }, "trusted proxy startup");
      assert.equal(startup.origin, "https://codesesh.example.com");
      const token = startup.searchParams.get("access_token");
      assert.equal((await proxyRequest(port, token)).status, 403);
      assert.equal((await proxyRequest(port, token, "http")).status, 403);
      const authorized = await proxyRequest(port, token, "https");
      assert.equal(authorized.status, 200, authorized.body);
      assert.ok(JSON.parse(authorized.body).some((agent) => agent.name === "codex"));
      assert.equal((await proxyRequest(port, "incorrect", "https")).status, 401);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);
