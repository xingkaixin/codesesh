import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  appendReply,
  createFixture,
  DETAIL_PATH,
  openEvents,
  readJson,
  REFERENCE,
  runCli,
  startServer,
  stop,
  waitFor,
} from "./harness.mjs";

test(
  "CLI JSON exposes an identified index and exits without changing its source",
  { timeout: 35_000 },
  async () => {
    const fixture = createFixture();
    try {
      const source = readFileSync(fixture.source);
      const result = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"]);
      assert.equal(result.code, 0, result.stderr);
      const index = JSON.parse(result.stdout);
      assert.equal(index.sessions.length, 1);
      assert.deepEqual(index.sessions[0].reference, REFERENCE);
      assert.equal(index.sessions[0].project_identity.kind, "path");
      assert.equal(index.sessions[0].project_identity.key, fixture.project);
      assert.equal(index.sessions[0].stats.message_count, 2);
      assert.equal(index.sessions[0].messages, undefined);
      assert.ok(index.agents.some((agent) => agent.name === "codex" && agent.count === 1));
      assert.deepEqual(readFileSync(fixture.source), source);
    } finally {
      fixture.dispose();
    }
  },
);

test(
  "HTTP preserves auth, wire responses, bookmarks and aliases across restart",
  { timeout: 60_000 },
  async () => {
    const fixture = createFixture();
    let server;
    try {
      server = await startServer(fixture);
      const unauthenticated = await fetch(`${server.origin}/api/sessions`);
      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(await readJson(server, "/api/config"), { window: { days: 0 } });
      const list = await readJson(server, "/api/sessions");
      assert.equal(list.sessions.length, 1);
      assert.deepEqual(list.sessions[0].reference, REFERENCE);
      const detail = await readJson(server, DETAIL_PATH);
      assert.equal(detail.messages.length, 2);
      assert.equal(detail.messages[0].parts[0].text, "Migration fixture 中文 🔎");
      assert.equal(
        detail.messages[1].parts[0].text,
        "A deterministic searchable reply: migration-needle.",
      );
      const search = await readJson(server, "/api/search?q=migration-needle");
      assert.deepEqual(search.results[0].reference, REFERENCE);
      await readJson(server, "/api/bookmarks", {
        method: "PUT",
        body: JSON.stringify({ reference: REFERENCE }),
      });
      await readJson(server, `/api/session-aliases/codex/${REFERENCE.sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ alias: "My migration alias" }),
      });
      assert.equal(
        (await readJson(server, "/api/sessions")).sessions[0].display_title,
        "My migration alias",
      );
      const stopped = await stop(server);
      if (process.platform === "win32") assert.equal(stopped.signal, "SIGTERM");
      else assert.equal(stopped.code, 0);
      server = await startServer(fixture);
      const bookmarks = await readJson(server, "/api/bookmarks");
      assert.equal(bookmarks.bookmarks.length, 1);
      assert.deepEqual(bookmarks.bookmarks[0].reference, REFERENCE);
      assert.equal(bookmarks.bookmarks[0].session.display_title, "My migration alias");
      await readJson(server, "/api/bookmarks", { method: "PUT", body: "{}" }, 400);
      await readJson(server, `/api/bookmarks/codex/${REFERENCE.sessionId}`, { method: "DELETE" });
      assert.deepEqual((await readJson(server, "/api/bookmarks")).bookmarks, []);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "an appended source publishes an SSE update whose detail is already readable",
  { timeout: 45_000 },
  async () => {
    const fixture = createFixture();
    let server;
    let stream;
    try {
      server = await startServer(fixture);
      stream = await openEvents(server);
      assert.equal(stream.events[0].type, "connected");
      appendReply(fixture);
      await waitFor(
        () =>
          stream.events.find(
            (event) =>
              event.type === "sessions-updated" &&
              event.data.changedSessionHeads.some(
                (entry) => entry.session.stats.message_count === 3,
              ),
          ),
        "committed appended session",
      );
      const detail = await readJson(server, DETAIL_PATH);
      assert.equal(detail.messages.length, 3);
      assert.equal(detail.messages[2].parts[0].text, "Live appended migration message");
    } finally {
      if (stream) await stream.close();
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);
