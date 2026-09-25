import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, totalmem, platform, release, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createFixture, launch, stop } from "../../tests/backend-contract/harness.mjs";

const exec = promisify(execFile);
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const samples = Number(args.samples ?? 5),
  warmups = Number(args.warmups ?? 1),
  requests = Number(args.requests ?? 30);
assert.ok(samples > 0 && requests > 0 && warmups >= 0);
const output = resolve(args.output ?? "docs/benchmarks/rust-migration-p6-current.json");
const commands = {
  node: [
    process.execPath,
    resolve("artifacts/backend-reference/registry/node_modules/codesesh/dist/index.js"),
  ],
  rust: [resolve(args.rust ?? "target/release/codesesh")],
};
const binaryRoot = mkdtempSync(join(tmpdir(), "codesesh-p6-binary-"));
const originalCommands = structuredClone(commands);
copyFileSync(
  commands.rust[0],
  join(binaryRoot, process.platform === "win32" ? "codesesh.exe" : "codesesh"),
);
commands.rust = [join(binaryRoot, process.platform === "win32" ? "codesesh.exe" : "codesesh")];
process.on("exit", () => rmSync(binaryRoot, { recursive: true, force: true }));
const configurations = [
  {
    name: "mixed-small",
    sessions: 30,
    messagesPerSession: 20,
    agents: ["codex", "deepchat", "minimax-code"],
  },
  {
    name: "mixed-history",
    sessions: 600,
    messagesPerSession: 40,
    agents: ["codex", "deepchat", "minimax-code"],
  },
  { name: "large-single-file", sessions: 1, messagesPerSession: 10000, agents: ["codex"] },
].filter((item) => !args.workloads || args.workloads.split(",").includes(item.name));
assert.ok(configurations.length);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) => sha(JSON.stringify(canonical(value)));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};
const directoryBytes = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true }).reduce(
      (sum, entry) =>
        sum +
        (entry.isDirectory()
          ? directoryBytes(join(path, entry.name))
          : statSync(join(path, entry.name)).size),
      0,
    );
  } catch {
    return 0;
  }
};
const epoch = Date.parse("2026-09-01T10:00:00Z");

function makeFixture(config) {
  const fixture = createFixture();
  rmSync(join(fixture.env.CODEX_HOME, "sessions"), { recursive: true, force: true });
  const codexDir = join(fixture.env.CODEX_HOME, "sessions", "2026", "09", "01");
  mkdirSync(codexDir, { recursive: true });
  const databases = {};
  for (const [agent, env, relative] of [
    ["deepchat", "DEEPCHAT_USER_DATA_DIR", "app_db/agent.db"],
    ["minimax-code", "MINIMAX_DATA_DIR", "v2/sqlite/runtime-state.sqlite"],
  ]) {
    if (!config.agents.includes(agent)) continue;
    const path = join(fixture.env[env], relative);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      readFileSync(
        resolve(`crates/codesesh-core/src/agents/${agent.replaceAll("-", "_")}/fixture.sql`),
        "utf8",
      ),
    );
    db.exec("BEGIN");
    databases[agent] = { db, path };
  }
  const paths = [];
  let appendPath, detailId;
  for (let index = 0; index < config.sessions; index++) {
    const agent = config.agents[index % config.agents.length];
    const id = `019fdefe-bb8d-76f3-b988-${String(index).padStart(12, "0")}`;
    const title = `Synthetic ${index} 中文 benchmark`;
    if (agent === "codex") {
      const path = join(codexDir, `rollout-2026-09-01T10-00-00-${id}.jsonl`);
      const records = [
        {
          timestamp: new Date(epoch + index).toISOString(),
          type: "session_meta",
          payload: { id, cwd: fixture.project, model: "migration-fixture" },
        },
      ];
      for (let m = 0; m < config.messagesPerSession; m++)
        records.push({
          timestamp: new Date(epoch + index + m + 1).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: m % 2 ? "assistant" : "user",
            content: [
              {
                type: m % 2 ? "output_text" : "input_text",
                text: `${title} message ${m} ${m === 3 ? "benchmark-needle 搜索 🔎" : "context"} ${"deterministic synthetic content. ".repeat(12)}`,
              },
            ],
          },
        });
      writeFileSync(path, records.map(JSON.stringify).join("\n") + "\n");
      utimesSync(
        path,
        (epoch + index + config.messagesPerSession) / 1000,
        (epoch + index + config.messagesPerSession) / 1000,
      );
      paths.push(path);
      if (!appendPath) {
        appendPath = path;
        detailId = id;
      }
    } else if (agent === "deepchat") {
      const db = databases[agent].db;
      db.prepare(
        "INSERT INTO new_sessions (id,agent_id,title,project_dir,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).run(
        id,
        "deepchat",
        title,
        fixture.project,
        epoch + index,
        epoch + index + config.messagesPerSession,
      );
      db.prepare("INSERT INTO deepchat_sessions VALUES (?,?,?)").run(
        id,
        "migration-fixture",
        "fixture",
      );
      const insert = db.prepare(
        "INSERT INTO deepchat_messages (id,session_id,order_seq,role,content,metadata,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (let m = 0; m < config.messagesPerSession; m++) {
        const text = `${title} message ${m} ${m === 3 ? "benchmark-needle 搜索 🔎" : "context"} ${"deterministic synthetic content. ".repeat(12)}`;
        insert.run(
          `${id}:${m}`,
          id,
          m,
          m % 2 ? "assistant" : "user",
          JSON.stringify(m % 2 ? [{ type: "content", content: text }] : { text }),
          "{}",
          "sent",
          epoch + index + m + 1,
          epoch + index + m + 1,
        );
      }
    } else {
      const db = databases[agent].db;
      db.prepare(
        "INSERT INTO local_runtime_sessions (session_id,title,workspace_dir,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)",
      ).run(id, title, fixture.project, epoch + index, epoch + index + config.messagesPerSession);
      const insert = db.prepare(
        "INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,source,created_at_ms,data_json) VALUES (?,?,?,?,?,?,?)",
      );
      for (let m = 0; m < config.messagesPerSession; m++)
        insert.run(
          id,
          `${id}:${m}`,
          m % 2 ? "assistant" : "user",
          `turn-${m}`,
          "user",
          epoch + index + m + 1,
          JSON.stringify({
            msg_id: `${id}:${m}`,
            msg_content: `${title} message ${m} ${m === 3 ? "benchmark-needle 搜索 🔎" : "context"} ${"deterministic synthetic content. ".repeat(12)}`,
            finish_reason: m % 2 ? "stop" : null,
          }),
        );
    }
  }
  for (const { db, path } of Object.values(databases)) {
    db.exec("COMMIT");
    db.close();
    paths.push(path);
  }
  fixture.appendPath = appendPath;
  fixture.detailPath = `/api/sessions/codex/${detailId}`;
  fixture.original = readFileSync(appendPath);
  fixture.sourceMtime = statSync(appendPath).mtimeMs;
  fixture.manifest = paths.sort().map((path) => ({
    path: path.slice(fixture.root.length + 1),
    bytes: statSync(path).size,
    sha256: sha(readFileSync(path)),
    mtimeMs: statSync(path).mtimeMs,
  }));
  fixture.sourceBytes = fixture.manifest.reduce((sum, file) => sum + file.bytes, 0);
  fixture.sourceHash = digest(fixture.manifest);
  return fixture;
}

function clearCache(fixture) {
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(fixture.root, `.cache/codesesh/codesesh.db${suffix}`), { force: true });
}

function engineVersion(fixture) {
  try {
    const n = readFileSync(join(fixture.root, ".cache/codesesh/codesesh.db")).readUInt32BE(96);
    return `${Math.floor(n / 1000000)}.${Math.floor(n / 1000) % 1000}.${n % 1000}`;
  } catch {
    return null;
  }
}

async function invocation(fixture, command, cliArgs) {
  const measured =
    platform() === "darwin"
      ? ["/usr/bin/time", "-l", ...command]
      : platform() === "linux"
        ? ["/usr/bin/time", "-v", ...command]
        : command;
  const started = performance.now();
  const process = launch(fixture, cliArgs, measured);
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 180000);
  try {
    const result = await process.completed;
    assert.equal(result.code, 0, result.stderr);
    const mac = result.stderr.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
    const user = mac?.[2] ?? result.stderr.match(/User time \(seconds\):\s*([\d.]+)/)?.[1];
    const system = mac?.[3] ?? result.stderr.match(/System time \(seconds\):\s*([\d.]+)/)?.[1];
    const rss = result.stderr.match(/(\d+)\s+maximum resident set size/)?.[1];
    const linux = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1];
    return {
      wallMs: performance.now() - started,
      userCpuMs: user ? Number(user) * 1000 : null,
      systemCpuMs: system ? Number(system) * 1000 : null,
      peakRssBytes: rss ? Number(rss) : linux ? Number(linux) * 1024 : null,
      stdout: result.stdout,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processUsage(pid) {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "rss=,time="]);
    const [rss, time] = stdout.trim().split(/\s+/);
    const fields = time.split(":").map(Number);
    let seconds = 0;
    for (const field of fields) seconds = seconds * 60 + field;
    return { rssBytes: Number(rss) * 1024, cpuMs: seconds * 1000 };
  } catch {
    return { rssBytes: null, cpuMs: null };
  }
}

async function poll(read, label, timeout = 180000) {
  const end = performance.now() + timeout;
  let last;
  while (performance.now() < end) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}

async function request(server, path, allowFailure = false) {
  const started = performance.now();
  const response = await fetch(new URL(path, server.origin), {
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${server.token}` },
  });
  const firstByteMs = performance.now() - started;
  const text = await response.text();
  const wallMs = performance.now() - started;
  if (!allowFailure) {
    assert.equal(response.status, 200, `${path}: ${response.status} ${text.slice(0, 500)}`);
  }
  return {
    firstByteMs,
    wallMs,
    bytes: Buffer.byteLength(text),
    body: JSON.parse(text),
    status: response.status,
  };
}

async function web(fixture, config, command, hot = false, traffic = false) {
  const started = performance.now();
  const process = launch(
    fixture,
    [
      "--agent",
      config.agents.join(","),
      "--days",
      "0",
      "--noOpen",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    command,
  );
  const rssSamples = [];
  let monitorBusy = false;
  const monitor = setInterval(async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const value = await processUsage(process.child.pid);
      if (value.rssBytes) rssSamples.push({ elapsedMs: performance.now() - started, ...value });
    } finally {
      monitorBusy = false;
    }
  }, 200);
  let server;
  try {
    const url = await poll(() => {
      if (process.child.exitCode !== null) throw new Error(JSON.stringify(process.output()));
      return [...process.output().stdout.matchAll(/https?:\/\/\S+/g)]
        .map((m) => new URL(m[0]))
        .find((u) => u.searchParams.has("access_token"));
    }, "startup URL");
    url.hostname = "127.0.0.1";
    server = { ...process, origin: url.origin, token: url.searchParams.get("access_token") };
    await request(server, "/api/config");
    const httpReadyMs = performance.now() - started;
    await poll(async () => {
      const response = await request(server, "/api/sessions");
      return response.body.sessions?.length > 0;
    }, "first nonempty list");
    const firstUsableListMs = performance.now() - started;
    const duringBackfill = [];
    await poll(async () => {
      const { body: status } = await request(server, "/api/status");
      if (
        traffic &&
        (status.active || status.backfill?.active || status.searchIndexMaintenance?.active)
      ) {
        for (const [name, path] of [
          ["list", "/api/sessions"],
          ["search", "/api/search?q=benchmark-needle"],
          ["detail", fixture.detailPath],
        ]) {
          const value = await request(server, path, true);
          duringBackfill.push({
            endpoint: name,
            status: value.status,
            wallMs: value.wallMs,
            firstByteMs: value.firstByteMs,
            bytes: value.bytes,
          });
        }
      }
      if (status.failedAgents?.length || status.backfill?.failedAgents?.length)
        throw new Error(JSON.stringify(status));
      return (
        !status.active &&
        !status.backfill?.active &&
        !status.searchIndexMaintenance?.active &&
        config.agents.every((agent) => status.completedAgents?.includes(agent))
      );
    }, "all scan/backfill/index completion");
    const indexedReadyMs = performance.now() - started;
    const list = (await request(server, "/api/sessions")).body;
    assert.equal(list.sessions.length, config.sessions);
    if (hot)
      return {
        httpReadyMs,
        firstUsableListMs,
        indexedReadyMs,
        listDigest: digest(list),
        duringBackfill,
      };
    const endpoints = {
      list: "/api/sessions",
      search: "/api/search?q=benchmark-needle",
      searchUnicode: "/api/search?q=%E6%90%9C%E7%B4%A2",
      detail: fixture.detailPath,
    };
    const timings = {};
    const payloads = {};
    const rawPayloads = {};
    for (const [name, path] of Object.entries(endpoints)) {
      const first = await request(server, path);
      payloads[name] = digest(first.body);
      rawPayloads[name] = first.body;
      timings[name] = {
        firstRequest: { firstByteMs: first.firstByteMs, wallMs: first.wallMs, bytes: first.bytes },
        samples: [],
      };
    }
    for (let i = 0; i < requests; i++)
      for (const [name, path] of Object.entries(endpoints)) {
        const value = await request(server, path);
        timings[name].samples.push({
          firstByteMs: value.firstByteMs,
          wallMs: value.wallMs,
          bytes: value.bytes,
        });
      }
    const beforeIdle = await processUsage(process.child.pid);
    await delay(2000);
    const steady = [];
    for (let i = 0; i < 5; i++) {
      steady.push(await processUsage(process.child.pid));
      await delay(100);
    }
    const afterIdle = steady.at(-1);
    const marker = "P6 appended synthetic message";
    const appendStarted = performance.now();
    appendFileSync(
      fixture.appendPath,
      JSON.stringify({
        timestamp: new Date(epoch + 9999999).toISOString(),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
      }) + "\n",
    );
    const appended = await poll(
      async () => {
        const response = await request(server, fixture.detailPath);
        return response.body.messages.some((message) =>
          message.parts.some((part) => part.text === marker),
        )
          ? response.body
          : false;
      },
      "append visible",
      60000,
    );
    const appendVisibleMs = performance.now() - appendStarted;
    return {
      httpReadyMs,
      firstUsableListMs,
      indexedReadyMs,
      timings,
      payloads,
      appendVisibleMs,
      appendDigest: digest(appended),
      rawPayloads: { ...rawPayloads, append: appended },
      steadyRssBytes: percentile(steady.map((s) => s.rssBytes).filter(Boolean), 0.5),
      sampledPeakRssBytes: rssSamples.length
        ? Math.max(...rssSamples.map((s) => s.rssBytes))
        : null,
      idleCpuMs:
        afterIdle.cpuMs !== null && beforeIdle.cpuMs !== null
          ? afterIdle.cpuMs - beforeIdle.cpuMs
          : null,
      rssSamples,
      sqliteWriterVersion: engineVersion(fixture),
      cacheBytes: directoryBytes(join(fixture.root, ".cache/codesesh")),
    };
  } finally {
    clearInterval(monitor);
    await stop(server ?? process);
  }
}

async function sqliteMetadata() {
  const require = createRequire(originalCommands.node.at(-1));
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const node = {
    version: db.prepare("SELECT sqlite_version() AS version").get().version,
    compileOptions: db.pragma("compile_options").map((row) => row.compile_options),
    source: "Frozen Node reference better-sqlite3 module",
  };
  db.close();
  let rust = {
    source: "Native release libsqlite3.a build-artifact proxy; not queried from the installed CLI",
    version: null,
    compileOptions: null,
  };
  try {
    const build = resolve("target/release/build");
    const candidates = readdirSync(build)
      .filter((name) => name.startsWith("libsqlite3-sys-"))
      .map((name) => join(build, name, "out/libsqlite3.a"))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) {
      const source = join(binaryRoot, "sqlite-probe.c");
      const binary = join(binaryRoot, "sqlite-probe");
      writeFileSync(
        source,
        "#include <stdio.h>\nextern const char *sqlite3_libversion(void);\nextern const char *sqlite3_compileoption_get(int);\nint main(void){puts(sqlite3_libversion());for(int i=0;;i++){const char *s=sqlite3_compileoption_get(i);if(!s)break;puts(s);}return 0;}\n",
      );
      await exec("cc", [source, candidates[0], "-lpthread", "-ldl", "-lm", "-o", binary]);
      const { stdout } = await exec(binary, []);
      const [version, ...compileOptions] = stdout.trim().split("\n");
      rust = {
        ...rust,
        version,
        compileOptions,
        archive: candidates[0],
        archiveSha256: sha(readFileSync(candidates[0])),
      };
    }
  } catch (error) {
    rust.error = error.message;
  }
  return { node, rust };
}

const toolchain = {
  rustc: (await exec("rustc", ["--version"])).stdout.trim(),
  cargo: (await exec("cargo", ["--version"])).stdout.trim(),
};
const sqlite = await sqliteMetadata();
const report = {
  generatedAt: new Date().toISOString(),
  stage: args.stage ?? "interim",
  environment: {
    os: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    node: process.version,
  },
  commands,
  originalCommands,
  toolchain,
  sqlite,
  referenceManifest: JSON.parse(readFileSync(resolve("tests/reference/manifest.json"), "utf8")),
  evaluatorSha256: sha(readFileSync(import.meta.filename)),
  binarySha256: Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [name, sha(readFileSync(command.at(-1)))]),
  ),
  method: {
    warmups,
    samplesPerScenario: samples,
    requestsPerEndpointPerIteration: requests,
    osPageCacheCleared: false,
    coldDefinition: "Application SQLite cache removed; OS filesystem cache is not cleared",
    execution:
      "Paired sequential runs on identical source files; backend order alternates per iteration. Other system/agent workloads are not controlled.",
    timings:
      "performance.now wall clock; HTTP TTFB means fetch headers resolved; complete includes response body read, excludes JSON parse",
    bodyBytes:
      "Decoded UTF-8 response body bytes after fetch automatic decompression; not wire transfer bytes",
    appendVisibility:
      "Wall time from synchronous append until 25 ms polling observes the marker in the full detail response; includes observer request/body/JSON work",
    cliCpu: "/usr/bin/time user+system seconds; not wall time",
    cliPeakRss: "/usr/bin/time OS high-water RSS for one-shot process",
    webPeakRss: "Sampled ps RSS every 200 ms: observed maximum, not OS high-water RSS",
    steadyRss: "Median of five ps RSS samples after 2 seconds idle",
    idleCpu:
      "ps cumulative CPU delta over approximately 2.5 seconds; coarse centisecond resolution",
    latencyP95: "Aggregated endpoint request observations, not five startup samples",
    sqliteCompileOptions:
      "Node options queried from frozen module; Rust options queried from native release static build archive (proxy, not installed CLI). SQLite writer version also read from each cache file header",
    writeBytes:
      "Actual physical/logical write volume and parser/query counts not instrumented; cacheBytes is final on-disk cache size only",
    unmeasured: [
      "Browser first interactive paint",
      "Packaged installer download/decompression size",
      "Per-query query plan",
    ],
    equivalence:
      "Full canonical JSON digests for CLI, list, search, Unicode search, detail and appended detail; no fields removed. Dynamic cursors can trigger reported mismatches; they are not silently dropped.",
  },
  workloads: configurations,
  fixtures: [],
  samples: [],
  errors: [],
  summary: [],
};
mkdirSync(dirname(output), { recursive: true });

function firstDifference(a, b, path = "$") {
  if (a === b) return null;
  if (!a || !b || typeof a !== "object" || typeof b !== "object")
    return { path, node: a ?? null, rust: b ?? null, nodeType: typeof a, rustType: typeof b };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDifference(a[key], b[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function save() {
  writeFileSync(
    output,
    JSON.stringify(report, (key, value) => (key === "rawPayloads" ? undefined : value), 2) + "\n",
  );
}

for (const config of configurations) {
  for (let iteration = -warmups; iteration < samples; iteration++) {
    const fixture = makeFixture(config);
    const pair = {};
    report.fixtures.push({
      workload: config.name,
      iteration,
      sourceBytes: fixture.sourceBytes,
      sourceHash: fixture.sourceHash,
      manifest: fixture.manifest,
    });
    try {
      for (const backend of iteration % 2 === 0 ? ["node", "rust"] : ["rust", "node"]) {
        const sample = {
          workload: config.name,
          iteration,
          warmup: iteration < 0,
          backend,
          sourceHash: fixture.sourceHash,
        };
        console.error(`${config.name} ${iteration < 0 ? "warmup" : iteration} ${backend}`);
        try {
          writeFileSync(fixture.appendPath, fixture.original);
          utimesSync(fixture.appendPath, fixture.sourceMtime / 1000, fixture.sourceMtime / 1000);
          clearCache(fixture);
          const version = await invocation(fixture, commands[backend], ["--version"]);
          sample.version = { ...version };
          const cold = await invocation(fixture, commands[backend], [
            "--json",
            "--agent",
            config.agents.join(","),
            "--days",
            "0",
          ]);
          const coldValue = JSON.parse(cold.stdout);
          assert.equal(coldValue.sessions.length, config.sessions);
          sample.coldJson = {
            ...cold,
            stdout: undefined,
            payloadDigest: digest(coldValue),
            rawPayloads: coldValue,
          };
          const warm = await invocation(fixture, commands[backend], [
            "--json",
            "--agent",
            config.agents.join(","),
            "--days",
            "0",
          ]);
          sample.warmJson = {
            ...warm,
            stdout: undefined,
            payloadDigest: digest(JSON.parse(warm.stdout)),
            rawPayloads: JSON.parse(warm.stdout),
          };
          clearCache(fixture);
          sample.coldWeb = await web(fixture, config, commands[backend]);
          writeFileSync(fixture.appendPath, fixture.original);
          utimesSync(fixture.appendPath, fixture.sourceMtime / 1000, fixture.sourceMtime / 1000);
          sample.hotWeb = await web(fixture, config, commands[backend], true);
          if (config.name === "mixed-history") {
            clearCache(fixture);
            sample.backfillWeb = await web(fixture, config, commands[backend], true, true);
          }
          for (const source of fixture.manifest) {
            assert.equal(
              sha(readFileSync(join(fixture.root, source.path))),
              source.sha256,
              `Source changed: ${source.path}`,
            );
          }
          pair[backend] = sample;
        } catch (error) {
          sample.error = error.stack ?? String(error);
          report.errors.push({ workload: config.name, iteration, backend, error: sample.error });
        }
        report.samples.push(sample);
        save();
      }
      if (pair.node && pair.rust) {
        const fields = {
          coldJson: [pair.node.coldJson.payloadDigest, pair.rust.coldJson.payloadDigest],
          warmJson: [pair.node.warmJson.payloadDigest, pair.rust.warmJson.payloadDigest],
          ...Object.fromEntries(
            Object.keys(pair.node.coldWeb.payloads).map((key) => [
              key,
              [pair.node.coldWeb.payloads[key], pair.rust.coldWeb.payloads[key]],
            ]),
          ),
          append: [pair.node.coldWeb.appendDigest, pair.rust.coldWeb.appendDigest],
        };
        for (const [field, [node, rust]] of Object.entries(fields))
          if (node !== rust)
            report.errors.push({
              workload: config.name,
              iteration,
              kind: "equivalence",
              firstDifference: firstDifference(
                field === "coldJson"
                  ? pair.node.coldJson.rawPayloads
                  : field === "warmJson"
                    ? pair.node.warmJson.rawPayloads
                    : pair.node.coldWeb.rawPayloads[field],
                field === "coldJson"
                  ? pair.rust.coldJson.rawPayloads
                  : field === "warmJson"
                    ? pair.rust.warmJson.rawPayloads
                    : pair.rust.coldWeb.rawPayloads[field],
              ),
              field,
              node,
              rust,
            });
      }
      for (const sample of Object.values(pair)) {
        delete sample.coldJson.rawPayloads;
        delete sample.warmJson.rawPayloads;
        delete sample.coldWeb.rawPayloads;
      }
    } finally {
      fixture.dispose();
      save();
    }
  }
}
for (const config of configurations) {
  const rows = report.samples.filter((s) => s.workload === config.name && !s.warmup && !s.error);
  const node = rows.filter((s) => s.backend === "node"),
    rust = rows.filter((s) => s.backend === "rust");
  const metrics = {
    coldJsonWallMs: (s) => s.coldJson.wallMs,
    coldJsonCpuMs: (s) =>
      s.coldJson.userCpuMs === null ? null : s.coldJson.userCpuMs + s.coldJson.systemCpuMs,
    warmJsonCpuMs: (s) =>
      s.warmJson.userCpuMs === null ? null : s.warmJson.userCpuMs + s.warmJson.systemCpuMs,
    warmJsonWallMs: (s) => s.warmJson.wallMs,
    coldJsonPeakRssBytes: (s) => s.coldJson.peakRssBytes,
    coldWebHttpReadyMs: (s) => s.coldWeb.httpReadyMs,
    coldWebIndexedReadyMs: (s) => s.coldWeb.indexedReadyMs,
    hotWebHttpReadyMs: (s) => s.hotWeb.httpReadyMs,
    steadyRssBytes: (s) => s.coldWeb.steadyRssBytes,
    sampledPeakRssBytes: (s) => s.coldWeb.sampledPeakRssBytes,
    appendVisibleMs: (s) => s.coldWeb.appendVisibleMs,
  };
  for (const [metric, get] of Object.entries(metrics)) {
    const a = percentile(
        node.map(get).filter((v) => v !== null),
        0.5,
      ),
      b = percentile(
        rust.map(get).filter((v) => v !== null),
        0.5,
      );
    report.summary.push({
      workload: config.name,
      metric,
      nodeValue: a,
      rustValue: b,
      rustOverNode: a && b ? b / a : null,
      regressionScreen: a && b ? b / a > 1.2 : null,
    });
  }
  if (config.name === "mixed-history") {
    for (const endpoint of ["list", "search", "detail"]) {
      const attempts = (group) =>
        group.flatMap((s) =>
          (s.backfillWeb?.duringBackfill ?? []).filter((v) => v.endpoint === endpoint),
        );
      const successful = (group) =>
        attempts(group)
          .filter((v) => v.status === 200)
          .map((v) => v.wallMs);
      const states = (group) =>
        attempts(group).reduce((counts, v) => {
          counts[v.status] = (counts[v.status] ?? 0) + 1;
          return counts;
        }, {});
      for (const p of [0.5, 0.95]) {
        const a = percentile(successful(node), p),
          b = percentile(successful(rust), p);
        report.summary.push({
          workload: config.name,
          metric: `backfill${endpoint}P${p * 100}WallMs`,
          nodeValue: a,
          rustValue: b,
          rustOverNode: a && b ? b / a : null,
          observationsPerBackend: { node: successful(node).length, rust: successful(rust).length },
          httpStatuses: { node: states(node), rust: states(rust) },
          regressionScreen: a && b ? b / a > 1.2 : null,
        });
      }
    }
  }
  for (const endpoint of ["list", "search", "searchUnicode", "detail"]) {
    for (const p of [0.5, 0.95]) {
      const values = (group) =>
        group.flatMap((s) => s.coldWeb.timings[endpoint].samples.map((v) => v.wallMs));
      const a = percentile(values(node), p),
        b = percentile(values(rust), p);
      report.summary.push({
        workload: config.name,
        metric: `${endpoint}P${p * 100}WallMs`,
        nodeValue: a,
        rustValue: b,
        rustOverNode: a && b ? b / a : null,
        observationsPerBackend: { node: values(node).length, rust: values(rust).length },
        regressionScreen: a && b ? b / a > 1.2 : null,
      });
    }
  }
}
report.completedAt = new Date().toISOString();
save();
const lines = [
  "# Rust P6 同机配对性能记录",
  "",
  `阶段：${report.stage}。生成：${report.completedAt}。`,
  "",
  `机器：${report.environment.cpu} / ${report.environment.os} ${report.environment.release} / ${report.environment.arch}；Node ${process.version}。每场景预热 ${warmups} 次，正式 ${samples} 次；每轮每端点 ${requests} 个请求。`,
  "",
  "冷启动仅指删除应用 SQLite 缓存，未清空 OS 页缓存。测试期间其他 Agent/系统负载未隔离。Web RSS 峰值为 200ms 采样最大值；CLI 峰值来自 OS high-water。时间均为墙钟；CPU 原始样本单独保存。",
  "",
  `完整记录及原始样本：[JSON](${output.split(/[\\/]/).at(-1)})。完整 JSON 等价错误及执行错误共 ${report.errors.length} 项，保留在 errors；有错误时本报告不构成验收通过。`,
  "",
  "| 工作负载 | 指标 | Node | Rust | Rust/Node |",
  "| --- | --- | ---: | ---: | ---: |",
  ...report.summary.map(
    (row) =>
      `| ${row.workload} | ${row.metric} | ${row.nodeValue?.toFixed(2) ?? "缺失"} | ${row.rustValue?.toFixed(2) ?? "缺失"} | ${row.rustOverNode?.toFixed(3) ?? "缺失"} |`,
  ),
  "",
  "`regressionScreen` 仅标记比值 > 1.2 供定位，不是新设的验收阈值。计划未约定统一加速倍数；不得据此忽略较小回退。大文件详情样本包含响应体接收，未计 JSON.parse；端点 p95 使用所有请求样本。",
  "",
  "未测项目：浏览器可交互时间、最终安装制品下载/解压体积、查询计划、物理写入量及解析次数。混合历史另有独立清缓存 backfill 流量场景，duringBackfill 记录每次list/search/detail延迟与HTTP状态；未ready详情保留503。SQLite 写入引擎版本来自各后端缓存文件头；Node编译选项读取固定模块，Rust选项读取本机release静态构建归档代理，不声称来自安装后的CLI。",
  "",
  "## 错误与回退",
  "",
  ...report.errors.map(
    (error) =>
      `- ${error.workload} / ${error.backend ?? error.kind} / ${error.field ?? "执行"}：${(error.error ?? `${error.node} != ${error.rust}`).split("\n")[0]}`,
  ),
  ...report.summary
    .filter((row) => row.regressionScreen)
    .map(
      (row) =>
        `- ${row.workload} ${row.metric}：Rust/Node ${row.rustOverNode.toFixed(3)}，需要定位。`,
    ),
  "",
];
writeFileSync(output.replace(/\.json$/, ".md"), lines.join("\n"));
console.log(output);
if (report.errors.length) process.exitCode = 1;
