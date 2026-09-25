import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  createReleaseCacheFixture,
  RELEASE_CACHE_FIXTURES,
} from "../reference/cache-release-fixtures.mjs";
import {
  createFixture,
  DETAIL_PATH,
  REFERENCE,
  readJson,
  runCli,
  startServer,
  stop,
} from "./harness.mjs";

const referenceRoot = resolve("artifacts/backend-reference/registry/node_modules/codesesh");
const reference = [process.execPath, join(referenceRoot, "dist/index.js")];
const rust = [resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`)];
const requireReference = createRequire(join(referenceRoot, "package.json"));
const Database = requireReference("better-sqlite3");
const cacheModule = readdirSync(join(referenceRoot, "dist"))
  .filter((name) => name.endsWith(".js"))
  .find((name) =>
    readFileSync(join(referenceRoot, "dist", name), "utf8").includes(
      "function readCachedSessions(agentName)",
    ),
  );
assert.ok(cacheModule, "The pinned npm reference must expose its cache implementation");
const cachePath = (fixture) => join(fixture.root, ".cache/codesesh/codesesh.db");
const tables = [
  "cache_meta",
  "agent_cache",
  "cache_initialization",
  "pending_reindex",
  "sessions",
  "messages",
  "message_tools",
  "session_documents",
  "session_file_activity",
  "session_model_cost",
  "session_cost_summary",
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}

function databaseFacts(path) {
  const db = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map(canonical)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]),
    );
  } finally {
    db.close();
  }
}

function nodeMigrate(fixture, agent) {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {readCachedSessions,closeCacheStorage} from ${JSON.stringify(pathToFileURL(join(referenceRoot, "dist", cacheModule)).href)}; const result=readCachedSessions(${JSON.stringify(agent)}); if(result.status!=="success") throw Error(JSON.stringify(result)); closeCacheStorage();`,
    ],
    { env: fixture.env, timeout: 60_000, stdio: "pipe" },
  );
}

function rustMigrate(fixture, path) {
  const input = join(fixture.root, "probe-input.json"),
    output = join(fixture.root, "probe-output.json");
  writeFileSync(input, JSON.stringify({ path, output }));
  const result = execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "-p",
      "codesesh-core",
      "storage::tests::external_cache_compatibility_probe",
      "--lib",
      "--",
      "--ignored",
      "--exact",
    ],
    {
      env: { ...process.env, CODESESH_CACHE_PROBE_INPUT: input },
      timeout: 180_000,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  assert.match(result, /1 passed/);
  return JSON.parse(readFileSync(output, "utf8"));
}

function stamp(db, version) {
  db.pragma(`user_version = ${version}`);
  db.prepare("UPDATE cache_meta SET value=? WHERE key='version'").run(String(version));
}

function seed(fixture) {
  return {
    agentName: "claudecode",
    session: {
      reference: { agentName: "claudecode", sessionId: "legacy-smoke" },
      title: "Legacy smoke session",
      directory: fixture.project,
      project_identity: { kind: "path", key: fixture.project, displayName: "project" },
      time_created: 1_700_000_000_000.125,
      time_updated: 1_700_000_000_001.875,
      stats: {
        message_count: 1,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0,
        total_tokens: 15,
      },
    },
    sourcePath: join(fixture.project, "session.jsonl"),
    searchContent: "legacy migration smoke needle content",
    messageText: "structured detail survived migration",
    filePath: join(fixture.project, "src/legacy.ts"),
    now: 1_700_000_000_002,
  };
}

for (const release of RELEASE_CACHE_FIXTURES) {
  test(
    `cache schema ${release.version} (${release.sourceTag}): pinned Node and Rust preserve the same rows`,
    { timeout: 180_000 },
    () => {
      const fixture = createFixture();
      try {
        const path = cachePath(fixture),
          rustPath = join(fixture.root, "rust-migration.db");
        mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path);
        createReleaseCacheFixture(db, release, seed(fixture));
        db.close();
        copyFileSync(path, rustPath);
        nodeMigrate(fixture, "claudecode");
        const expected = databaseFacts(path);
        const restored = rustMigrate(fixture, rustPath);
        assert.equal(restored.heads.length, 1);
        assert.equal(restored.heads[0].time_created, seed(fixture).session.time_created);
        assert.deepEqual(databaseFacts(rustPath), expected);
        assert.ok(
          readdirSync(fixture.root).some((name) =>
            name.includes(`cache-migration-${release.version}-`),
          ),
          "Rust keeps a pre-migration backup",
        );
      } finally {
        fixture.dispose();
      }
    },
  );
}

function addPricedUsage(fixture) {
  writeFileSync(
    join(fixture.root, ".cache/codesesh/models-dev-pricing.json"),
    JSON.stringify({
      timestamp: Date.now(),
      data: { "migration-fixture": { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002 } },
    }),
  );
  const usage = {
    input_tokens: 20,
    output_tokens: 7,
    reasoning_output_tokens: 3,
    cached_input_tokens: 5,
    total_tokens: 27,
  };
  appendFileSync(
    fixture.source,
    JSON.stringify({
      timestamp: "2026-09-01T10:00:03Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } },
    }) + "\n",
  );
}

const modernMigrations = [
  [24, "ALTER TABLE messages DROP COLUMN content_chain_digest;"],
  [
    28,
    "DROP INDEX idx_messages_usage_time; DROP TABLE session_cost_summary; CREATE TABLE session_cost_summary(agent_name TEXT NOT NULL,session_id TEXT NOT NULL,message_cost REAL NOT NULL,untimed_message_cost REAL NOT NULL,PRIMARY KEY(agent_name,session_id));",
  ],
  [
    29,
    "ALTER TABLE sessions ADD COLUMN slug TEXT; UPDATE sessions SET slug=agent_name||'/'||session_id;",
  ],
  [
    32,
    "DROP INDEX idx_messages_usage_time; CREATE INDEX idx_messages_usage_time ON messages(CASE WHEN time_completed>0 THEN time_completed WHEN time_created>0 THEN time_created END,agent_name,session_id);",
  ],
  [33, "DROP INDEX idx_messages_user_activity; ALTER TABLE messages DROP COLUMN automated;"],
];
for (const [version, downgrade] of modernMigrations) {
  test(
    `cache schema ${version}: actual npm cache upgrades identically in both implementations`,
    { timeout: 180_000 },
    async () => {
      const fixture = createFixture();
      let server;
      try {
        addPricedUsage(fixture);
        server = await startServer(fixture, reference);
        await readJson(server, DETAIL_PATH);
        await stop(server);
        server = undefined;
        const path = cachePath(fixture),
          rustPath = join(fixture.root, "rust-migration.db");
        const db = new Database(path);
        db.exec(downgrade);
        stamp(db, version);
        db.close();
        copyFileSync(path, rustPath);
        nodeMigrate(fixture, "codex");
        rustMigrate(fixture, rustPath);
        assert.deepEqual(databaseFacts(rustPath), databaseFacts(path));
      } finally {
        if (server) await stop(server);
        fixture.dispose();
      }
    },
  );
}

function stateFacts(fixture) {
  const db = new Database(join(fixture.root, "state/state.db"), { readonly: true });
  try {
    return Object.fromEntries(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => [
          name,
          db
            .prepare(`SELECT * FROM "${name}"`)
            .all()
            .map(canonical)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ]),
    );
  } finally {
    db.close();
  }
}

const responsePaths = [
  "/api/config",
  "/api/sessions",
  DETAIL_PATH,
  "/api/projects",
  "/api/search?q=migration-needle",
  "/api/file-activity",
  "/api/bookmarks",
  "/api/dashboard?from=2026-09-01&to=2026-09-02&timeZone=UTC",
];

async function responses(server) {
  const output = {};
  for (const path of responsePaths) output[path] = await readJson(server, path);
  return output;
}

test(
  "Node → Rust → Node → Rust share cache, HTTP, CLI, bookmarks and aliases",
  { timeout: 180_000 },
  async () => {
    const fixture = createFixture();
    let server;
    try {
      server = await startServer(fixture, reference);
      await readJson(server, "/api/bookmarks", {
        method: "PUT",
        body: JSON.stringify({ reference: REFERENCE }),
      });
      await readJson(server, `/api/session-aliases/codex/${REFERENCE.sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ alias: "Persistent Rust migration alias" }),
      });
      const expected = await responses(server);
      await stop(server);
      server = undefined;
      const state = stateFacts(fixture);
      const cli = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], reference);
      assert.equal(cli.code, 0, cli.stderr);
      for (const command of [rust, reference, rust]) {
        const actual = await runCli(
          fixture,
          ["--json", "--agent", "codex", "--days", "0"],
          command,
        );
        assert.equal(actual.code, 0, actual.stderr);
        assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(cli.stdout));
        server = await startServer(fixture, command);
        assert.deepEqual(await responses(server), expected);
        await stop(server);
        server = undefined;
        assert.deepEqual(stateFacts(fixture), state);
      }
      const cleared = await runCli(
        fixture,
        ["--clear-cache", "--json", "--agent", "codex", "--days", "0"],
        rust,
      );
      assert.equal(cleared.code, 0, cleared.stderr);
      assert.deepEqual(stateFacts(fixture), state);
      server = await startServer(fixture, reference);
      assert.deepEqual(await responses(server), expected);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "Rust repairs a broken external-content FTS index before publishing",
  { timeout: 180_000 },
  async () => {
    const fixture = createFixture();
    let server;
    try {
      server = await startServer(fixture, reference);
      const expected = await readJson(server, "/api/search?q=migration-needle");
      await stop(server);
      server = undefined;
      const db = new Database(cachePath(fixture));
      db.exec("INSERT INTO session_documents_fts(session_documents_fts) VALUES('delete-all')");
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM session_documents_fts WHERE session_documents_fts MATCH 'migration'",
          )
          .get().count,
        0,
      );
      db.close();
      const published = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
      assert.equal(published.code, 0, published.stderr);
      server = await startServer(fixture, rust);
      assert.deepEqual(await readJson(server, "/api/search?q=migration-needle"), expected);
      await stop(server);
      server = undefined;
      server = await startServer(fixture, reference);
      assert.deepEqual(await readJson(server, "/api/search?q=migration-needle"), expected);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "legacy parts format 0 and missing chains match the pinned Node materializer",
  { timeout: 180_000 },
  async () => {
    const fixture = createFixture();
    let server;
    try {
      server = await startServer(fixture, reference);
      await readJson(server, DETAIL_PATH);
      await stop(server);
      server = undefined;
      const db = new Database(cachePath(fixture));
      db.prepare(
        "UPDATE messages SET parts_json=?,parts_format_version=0,content_chain_digest=NULL WHERE agent_name='codex' AND message_index=1",
      ).run(
        JSON.stringify([
          {
            type: "tool",
            title: "tool: Read",
            state: {
              status: "success",
              arguments: { path: "src/legacy.ts" },
              result: "legacy result",
              duration: 1.25,
            },
            time_created: 1_790_326_527_892.125,
          },
          { type: "plan", input: { plan: "Legacy plan" }, approval_status: "success" },
          {
            type: "image",
            data: "YQ==",
            mime_type: "image/png",
            url: "https://example.test/a.png",
          },
        ]),
      );
      db.close();
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {readCachedSessions,materializeCachedSessionDetailResponse,closeCacheStorage} from ${JSON.stringify(pathToFileURL(join(referenceRoot, "dist", cacheModule)).href)}; const loaded=readCachedSessions("codex"); if(loaded.status!=="success")throw Error(JSON.stringify(loaded)); const {sessions,meta}=loaded.value; const scan={sessions,byAgent:{codex:sessions},agents:[{name:"codex",getSessionCacheMeta:id=>meta[id]}]}; const detail=materializeCachedSessionDetailResponse(scan,${JSON.stringify(REFERENCE)}); if(detail?.status!=="found-json")throw Error(JSON.stringify(detail)); console.log(JSON.stringify({...detail.data,messages:[...detail.messages].map(JSON.parse)})); closeCacheStorage();`,
        ],
        { env: fixture.env, timeout: 60_000, encoding: "utf8", stdio: "pipe" },
      );
      const expected = JSON.parse(result);
      const actual = rustMigrate(fixture, cachePath(fixture)).details[0];
      assert.deepEqual(actual, expected);
      const after = new Database(cachePath(fixture), { readonly: true });
      assert.equal(
        after
          .prepare("SELECT parts_format_version AS format FROM messages WHERE message_index=1")
          .get().format,
        0,
      );
      after.close();
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);

test(
  "Rust repairs a broken trigram file-activity index without losing tool facts",
  { timeout: 180_000 },
  async () => {
    const fixture = createFixture();
    let server;
    try {
      const payloads = [
        {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "cache-patch",
          input:
            "*** Begin Patch\n*** Add File: src/cache-legacy.ts\n+export const value = 1;\n*** End Patch",
        },
        { type: "custom_tool_call_output", call_id: "cache-patch", output: "Done." },
      ];
      appendFileSync(
        fixture.source,
        payloads
          .map((payload, index) =>
            JSON.stringify({
              timestamp: `2026-09-01T10:00:0${index + 4}Z`,
              type: "response_item",
              payload,
            }),
          )
          .join("\n") + "\n",
      );
      const path = "/api/file-activity?path=cache-legacy";
      server = await startServer(fixture, reference);
      const expected = await readJson(server, path);
      assert.equal(expected.activity.length, 1);
      await stop(server);
      server = undefined;
      const db = new Database(cachePath(fixture));
      db.exec(
        "INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts) VALUES('delete-all')",
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM session_file_activity_path_fts WHERE session_file_activity_path_fts MATCH 'legacy'",
          )
          .get().count,
        0,
      );
      db.close();
      const published = await runCli(fixture, ["--json", "--agent", "codex", "--days", "0"], rust);
      assert.equal(published.code, 0, published.stderr);
      server = await startServer(fixture, rust);
      assert.deepEqual(await readJson(server, path), expected);
      await stop(server);
      server = undefined;
      server = await startServer(fixture, reference);
      assert.deepEqual(await readJson(server, path), expected);
    } finally {
      if (server) await stop(server);
      fixture.dispose();
    }
  },
);
