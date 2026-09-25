import assert from "node:assert/strict";
import { writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { startServer, stop, openEvents, waitFor } from "./harness.mjs";
import {
  IDS,
  BOOKMARK_TIME,
  createFullApiFixture,
  resetBackendData,
  appendFullApiMessage,
} from "./fixtures/full-api/fixture.mjs";

const reference = [
  process.execPath,
  resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
];
const candidate = process.env.CODESESH_FULL_API_CANDIDATE_COMMAND
  ? JSON.parse(process.env.CODESESH_FULL_API_CANDIDATE_COMMAND)
  : [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const window = "from=2026-09-01&to=2026-09-02";
const referenceOf = (id) => ({ agentName: "codex", sessionId: id });
const detailOf = (id) => `/api/sessions/codex/${id}`;

function normalizeStatus(status) {
  const copy = structuredClone(status);
  // Only scan wall-clock fields vary between otherwise identical executions.
  for (const entry of [copy, ...Object.values(copy.agentStatuses ?? {})]) {
    for (const key of [
      "startedAt",
      "completedAt",
      "lastUpdatedAt",
      "updatedAt",
      "elapsedMs",
      "durationMs",
    ]) {
      if (typeof entry[key] === "number") {
        assert.ok(Number.isFinite(entry[key]));
        entry[key] = "<clock>";
      }
    }
  }
  return copy;
}

function normalizeEvent(event) {
  const copy = structuredClone(event);
  if (Object.hasOwn(copy.data, "timestamp")) {
    assert.ok(Number.isSafeInteger(copy.data.timestamp));
    assert.ok(Math.abs(Date.now() - copy.data.timestamp) < 60_000);
    copy.data.timestamp = "<event-clock>";
  }
  return copy;
}

async function capture(fixture, command) {
  let server;
  let stream;
  const results = [];
  const snapshots = new Map();
  function normalizeCursor(cursor) {
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    assert.equal(payload.version, 1);
    assert.match(payload.snapshot, uuid);
    assert.ok(Number.isSafeInteger(payload.offset) && payload.offset > 0);
    assert.equal(Buffer.from(JSON.stringify(payload)).toString("base64url"), cursor);
    if (!snapshots.has(payload.snapshot))
      snapshots.set(payload.snapshot, `snapshot-${snapshots.size + 1}`);
    payload.snapshot = snapshots.get(payload.snapshot);
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }
  async function take(label, path, options = {}) {
    const start = Date.now();
    const response = await server.request(path, options);
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    const normalized = structuredClone(body);
    if (normalized?.nextCursor) normalized.nextCursor = normalizeCursor(normalized.nextCursor);
    if (label === "alias put" && response.status === 200) {
      assert.ok(Number.isSafeInteger(body.alias.updatedAt));
      assert.ok(body.alias.updatedAt >= start && body.alias.updatedAt <= Date.now());
      normalized.alias.updatedAt = "<request-clock>";
    }
    results.push({
      label,
      status: response.status,
      body: label === "status" ? normalizeStatus(normalized) : normalized,
    });
    return { status: response.status, body };
  }
  const put = (body) => ({ method: "PUT", body: JSON.stringify(body) });
  const post = (body) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    server = await startServer(fixture, command);
    await take("unauthenticated", "/api/sessions", { headers: { Authorization: "" } });
    await take("foreign origin", "/api/sessions", {
      headers: { Origin: "https://attacker.invalid" },
    });
    await take("config", "/api/config");
    await take("status", "/api/status");
    await take("agents", "/api/agents");
    await take("projects", "/api/projects");
    await take("projects agent", "/api/projects?agent=codex");
    await take("projects unknown", "/api/projects?agent=unknown");
    const list = await take("sessions", "/api/sessions");
    assert.equal(list.body.sessions.length, 3);
    for (const [label, query] of [
      ["agent", "agent=codex"],
      ["unknown", "agent=unknown"],
      ["case agent", "agent=CoDeX"],
      ["q", "q=widget"],
      ["tag", "tag=docs"],
      ["project", `projectKind=path&projectKey=${encodeURIComponent(fixture.project)}`],
      ["cwd", `cwd=${encodeURIComponent(fixture.project)}`],
      ["window", window],
      ["excluded window", "from=2027-01-01&to=2027-01-02"],
      ["invalid limit", "limit=0"],
      ["invalid project", "projectKind=path"],
      ["invalid date", "from=not-a-date"],
    ])
      await take(`sessions ${label}`, `/api/sessions?${query}`);
    const page = await take("sessions page 1", "/api/sessions?limit=1");
    assert.ok(page.body.nextCursor, "three-session fixture must return pagination cursor");
    const page2 = await take(
      "sessions page 2",
      `/api/sessions?limit=1&cursor=${page.body.nextCursor}`,
    );
    assert.ok(page2.body.nextCursor);
    await take("sessions page 3", `/api/sessions?limit=1&cursor=${page2.body.nextCursor}`);
    await take("sessions replay cursor", `/api/sessions?limit=1&cursor=${page.body.nextCursor}`);
    await take(
      "sessions cursor query mismatch",
      `/api/sessions?limit=1&agent=codex&cursor=${page.body.nextCursor}`,
    );
    await take("sessions invalid cursor", "/api/sessions?cursor=invalid!");
    const stale = Buffer.from(
      JSON.stringify({ version: 1, snapshot: "00000000-0000-4000-8000-000000000000", offset: 1 }),
    ).toString("base64url");
    await take("sessions stale cursor", `/api/sessions?cursor=${stale}`);
    const detail = await take("detail", detailOf(IDS[0]));
    await take(
      "detail unchanged cursor",
      `${detailOf(IDS[0])}?messageCursor=${encodeURIComponent(detail.body.message_cursor)}`,
    );
    await take("detail invalid cursor", `${detailOf(IDS[0])}?messageCursor=invalid`);
    await take("detail unknown agent", "/api/sessions/unknown/id");
    await take("detail missing", "/api/sessions/codex/absent");
    for (const [label, q] of [
      ["empty", ""],
      ["text", "sharedneedle"],
      ["phrase", '"exact phrase"'],
      ["OR", "absent OR sharedneedle"],
      ["AND", "absent sharedneedle"],
      ["title", "widget"],
      ["tags", "tag:docs"],
      ["tool", "tool:apply_patch"],
      ["file", "file:Widget0.ts"],
      ["plain file", "Widget0.ts"],
      ["file text", "file:Widget0.ts sharedneedle"],
      ["file mismatch", "file:Widget0.ts absent"],
      ["file kind", "file:Widget0.ts kind:write"],
      ["cost", "cost:>=0.03 cost:<1"],
      ["cost absent", "cost:>999"],
      ["project", `project:"${fixture.project}"`],
      ["cwd", `cwd:"${fixture.other}"`],
      ["unknown qualifier", "invalid:thing"],
    ])
      await take(`search ${label}`, `/api/search?q=${encodeURIComponent(q)}`);
    for (const [label, query] of [
      ["unknown", "agent=unknown"],
      ["limit", "q=sharedneedle&limit=1"],
      ["invalid limit", "limit=0"],
      ["invalid project", "projectKind=path"],
      ["window", window],
    ])
      await take(`search ${label}`, `/api/search?${query}`);
    for (const [label, query] of [
      ["all", ""],
      ["path", "path=Widget0.ts"],
      ["kind", "kind=write"],
      ["invalid kind", "kind=invalid"],
      ["window", window],
      ["cwd", `cwd=${encodeURIComponent(fixture.other)}`],
      ["limit", "limit=1"],
      ["invalid limit", "limit=0"],
      ["unknown", "agent=unknown"],
    ])
      await take(`file activity ${label}`, `/api/file-activity?${query}`);
    for (const [label, query] of [
      ["window", window],
      ["agent", `${window}&agent=codex`],
      ["project", `${window}&projectKind=path&projectKey=${encodeURIComponent(fixture.project)}`],
      ["unknown", `${window}&agent=unknown`],
      ["invalid date", "from=bad"],
    ])
      await take(`dashboard ${label}`, `/api/dashboard?${query}`);
    await take("bookmarks empty", "/api/bookmarks");
    await take(
      "bookmarks import",
      "/api/bookmarks/import",
      post([
        { reference: referenceOf(IDS[0]), bookmarkedAt: BOOKMARK_TIME },
        { reference: referenceOf("missing"), bookmarkedAt: BOOKMARK_TIME - 1 },
        {
          reference: { agentName: "removed-agent", sessionId: "old" },
          bookmarkedAt: BOOKMARK_TIME - 2,
        },
      ]),
    );
    await take(
      "bookmark idempotent put",
      "/api/bookmarks",
      put({ reference: referenceOf(IDS[0]) }),
    );
    await take("bookmark invalid put", "/api/bookmarks", put({}));
    await take(
      "bookmark unknown put",
      "/api/bookmarks",
      put({ reference: { agentName: "unknown", sessionId: "old" } }),
    );
    await take(
      "bookmark invalid import",
      "/api/bookmarks/import",
      post([{ reference: referenceOf(IDS[1]), bookmarkedAt: "bad" }]),
    );
    await take(
      "alias put",
      `/api/session-aliases/codex/${IDS[0]}`,
      put({ alias: "  Custom alias fixture 🔎  " }),
    );
    await take("alias list", "/api/sessions?q=custom");
    await take("alias search", "/api/search?q=custom");
    await take("alias detail", detailOf(IDS[0]));
    await take("alias bookmark", "/api/bookmarks");
    await take("alias empty", `/api/session-aliases/codex/${IDS[0]}`, put({ alias: " " }));
    await take(
      "alias too long",
      `/api/session-aliases/codex/${IDS[0]}`,
      put({ alias: "x".repeat(161) }),
    );
    await take("alias unknown", "/api/session-aliases/unknown/id", put({ alias: "abc" }));
    await take(
      "logs valid",
      "/api/logs",
      post({ level: "info", event: "app.load.done", data: { query_length: 3, results: 1 } }),
    );
    await take("logs invalid", "/api/logs", post({ level: "invalid" }));
    await take("logs malformed", "/api/logs", { method: "POST", body: "{" });
    stream = await openEvents(server);
    results.push({
      label: "events connected",
      status: 200,
      body: normalizeEvent(stream.events.find((e) => e.type === "connected")),
    });
    const initialEvent = stream.events.find((e) => e.type === "scan-status");
    results.push({
      label: "events scan status",
      status: 200,
      body: { ...initialEvent, data: normalizeStatus(initialEvent.data) },
    });
    await stream.close();
    stream = undefined;
    await stop(server);
    server = await startServer(fixture, command);
    await take("bookmarks after restart", "/api/bookmarks");
    await take("alias after restart", detailOf(IDS[0]));
    await take("alias delete", `/api/session-aliases/codex/${IDS[0]}`, { method: "DELETE" });
    await take("bookmark delete", `/api/bookmarks/codex/${IDS[0]}`, { method: "DELETE" });
    await take("bookmark unknown delete", "/api/bookmarks/unknown/id", { method: "DELETE" });
    await take("alias unknown delete", "/api/session-aliases/unknown/id", { method: "DELETE" });
    await take("bookmarks final", "/api/bookmarks");
    stream = await openEvents(server);
    appendFullApiMessage(fixture);
    await waitFor(
      () =>
        stream.events.find(
          (e) =>
            e.type === "sessions-updated" &&
            e.data.changedSessionHeads.some(
              (h) =>
                h.reference.sessionId === IDS[0] &&
                h.session.time_updated > Date.parse("2026-09-01T10:04:00Z"),
            ),
        ),
      "appended session SSE commit",
    );
    const update = stream.events.find(
      (e) =>
        e.type === "sessions-updated" &&
        e.data.changedSessionHeads.some(
          (h) =>
            h.reference.sessionId === IDS[0] &&
            h.session.time_updated > Date.parse("2026-09-01T10:04:00Z"),
        ),
    );
    results.push({ label: "events committed update", status: 200, body: normalizeEvent(update) });
    await take(
      "detail append cursor",
      `${detailOf(IDS[0])}?messageCursor=${encodeURIComponent(detail.body.message_cursor)}`,
    );
    return results;
  } catch (error) {
    error.observations = results;
    throw error;
  } finally {
    if (stream) await stream.close();
    if (server) await stop(server);
  }
}

test(
  "all 17 Rust API endpoints match the frozen Node reference",
  { timeout: 180_000 },
  async () => {
    const fixture = createFullApiFixture();
    const source = readFileSync(fixture.source);
    const sourceStat = statSync(fixture.source);
    let expected;
    let actual;
    try {
      expected = await capture(fixture, reference);
      resetBackendData(fixture);
      writeFileSync(fixture.source, source);
      utimesSync(fixture.source, sourceStat.atime, sourceStat.mtime);
      actual = await capture(fixture, candidate);
      if (process.env.CODESESH_FULL_API_REPORT)
        writeFileSync(
          process.env.CODESESH_FULL_API_REPORT,
          JSON.stringify({ expected, actual }, null, 2),
        );
      assert.equal(actual.length, expected.length);
      const failures = [];
      for (let index = 0; index < expected.length; index++) {
        try {
          assert.deepEqual(actual[index], expected[index]);
        } catch (error) {
          failures.push(new Error(`${expected[index].label}: ${error.message}`));
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `${failures.length}/${expected.length} API observations differ`,
        );
    } catch (error) {
      if (process.env.CODESESH_FULL_API_REPORT && (!actual || !expected)) {
        writeFileSync(
          process.env.CODESESH_FULL_API_REPORT,
          JSON.stringify(
            { expected, actual: actual ?? error.observations, error: error.message },
            null,
            2,
          ),
        );
      }
      throw error;
    } finally {
      fixture.dispose();
    }
  },
);
