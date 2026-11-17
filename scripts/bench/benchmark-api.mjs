import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, homedir, loadavg, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { sessionRoutePath } from "@codesesh/contract";
import { createFixture, launch, stop } from "../../tests/backend-contract/harness.mjs";
import { nativeBinary } from "../lib/native-command.mjs";
import { resolveTimeWindow } from "../../apps/web/src/lib/time-window.ts";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: join(homedir(), ".codesesh/codesesh.db") },
    binary: { type: "string", default: nativeBinary },
    base: { type: "string" },
    snapshot: { type: "string" },
    output: { type: "string", default: "artifacts/api-hotspots/result.json" },
    runs: { type: "string", default: "5" },
    days: { type: "string", default: "7" },
  },
});
const runs = Number(values.runs);
const days = Number(values.days);
assert.ok(Number.isInteger(runs) && runs > 0, "--runs must be a positive integer");
assert.ok(Number.isInteger(days) && days >= 0, "--days must be a non-negative integer");
const output = resolve(values.output);
const binary = resolve(values.binary);
const variants = [{ name: "head", binary }];
if (values.base) variants.unshift({ name: "base", binary: resolve(values.base) });
const resolvedAt = Date.now();
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const exec = promisify(execFile);
const fixture = createFixture();
const ownedFixture = { ...fixture };
if (values.snapshot) {
  const snapshot = resolve(values.snapshot);
  for (const [key, value] of Object.entries(fixture.env)) {
    if (value.startsWith(fixture.root))
      fixture.env[key] = snapshot + value.slice(fixture.root.length);
  }
  fixture.project = join(snapshot, "project");
  fixture.root = snapshot;
}
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
fixture.env.TZ = timeZone;
fixture.env.CODESESH_LOG_LEVEL = "debug";
fixture.env.CODESESH_STATE_DIR = join(fixture.root, ".codesesh");
const report = {
  measuredAt: new Date().toISOString(),
  commit: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  binaries: Object.fromEntries(
    variants.map((variant) => [
      variant.name,
      createHash("sha256").update(readFileSync(variant.binary)).digest("hex"),
    ]),
  ),
  harnessSha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    node: process.version,
    timeZone,
    load: loadavg(),
  },
  method: {
    runs,
    days,
    warmups: 1,
    server: "isolated Hub; no scanning or worker uploads",
    cache:
      "each run restarts the process, then repeats the homepage batch; OS page cache is not cleared",
    requests: "page parameters, gzip, complete response consumption and separate JSON parse timing",
    resources:
      "whole server process around each scenario; CPU is ps cumulative user+system time, RSS is sampled, not an OS high-water mark",
    scope: "diagnostic baseline on this machine, not an A/B verdict or a capacity claim",
    comparison: values.base
      ? "base/head order alternates per pair; identical frozen cache"
      : "single binary",
    parity:
      "complete business JSON; session and project pages reassembled with their own cursors; config excluded; all-time dashboard end is fixed",
    resolvedAt,
  },
  dataset: null,
  samples: [],
  queries: [],
  errors: [],
  parity: [],
};
let activities;
const previousOutputs = new Map();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

async function verifyOutputs(server, sample, responses) {
  const projects = responses.get("projects");
  if (projects) {
    let page = projects.body;
    const items = [...page.projects];
    let pages = 1;
    while (page.nextCursor) {
      const url = new URL(projects.path, server.origin);
      url.searchParams.set("cursor", page.nextCursor);
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      assert.equal(response.status, 200, "Project parity pagination failed");
      page = await response.json();
      items.push(...page.projects);
      pages++;
    }
    responses.set("projects", { body: { projects: items, summary: projects.body.summary } });
    sample.parityProjectPages = pages;
  }
  sample.responses = Object.fromEntries(
    [...responses].map(([label, response]) => [
      label,
      createHash("sha256")
        .update(JSON.stringify(canonical(response.body)))
        .digest("hex"),
    ]),
  );
  if (!values.base) return;
  const key = `${sample.run}/${sample.scenario}`;
  const previous = previousOutputs.get(key);
  if (!previous) {
    previousOutputs.set(key, sample.responses);
    return;
  }
  const mismatches = [
    ...new Set([...Object.keys(previous), ...Object.keys(sample.responses)]),
  ].filter((label) => previous[label] !== sample.responses[label]);
  report.parity.push({
    run: sample.run,
    scenario: sample.scenario,
    matches: mismatches.length === 0,
    mismatches,
  });
  assert.equal(mismatches.length, 0, `Business response mismatch: ${mismatches.join(", ")}`);
}

async function snapshotDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // Pin a WAL read snapshot so active worker uploads cannot restart the backup indefinitely.
    db.exec("BEGIN");
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    await backup(db, destination, { rate: 65_536 });
  } finally {
    db.close();
  }
}

async function usage(pid) {
  if (process.platform === "win32") return null;
  const result = await exec("ps", ["-p", String(pid), "-o", "rss=,time="]);
  const [rss, time] = result.stdout.trim().split(/\s+/);
  const seconds = time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return { rssBytes: Number(rss) * 1024, cpuMs: seconds * 1000 };
}

async function measure(server, scenario, run, action) {
  const before = await usage(server.child.pid);
  const memory = [];
  let sampling = Promise.resolve();
  const timer = setInterval(() => {
    sampling = sampling.then(async () => memory.push(await usage(server.child.pid)));
  }, 250);
  const sample = {
    scenario,
    run,
    variant: server.variant,
    warmup: run < 0,
    load: loadavg(),
    requests: [],
  };
  const responses = new Map();
  const started = performance.now();
  async function request(label, path) {
    const requestStarted = performance.now();
    const response = await fetch(new URL(path, server.origin), {
      headers: { "Accept-Encoding": "gzip" },
      signal: AbortSignal.timeout(120_000),
    });
    const headersMs = performance.now() - requestStarted;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const bodyMs = performance.now() - requestStarted;
    const body = JSON.parse(new TextDecoder().decode(bytes));
    sample.requests.push({
      label,
      status: response.status,
      headersMs,
      bodyMs,
      totalMs: performance.now() - requestStarted,
      decodedBytes: bytes.length,
      completedAtMs: performance.now() - started,
      requestId: response.headers.get("x-codesesh-request-id"),
    });
    assert.equal(response.status, 200, `${label}: HTTP ${response.status}`);
    if (label !== "config" && label !== "sessions-page") responses.set(label, { path, body });
    return body;
  }
  try {
    await action(request, sample, started, responses);
    sample.wallMs = performance.now() - started;
  } finally {
    clearInterval(timer);
    await sampling;
    const after = await usage(server.child.pid);
    sample.cpuMs = before && after ? after.cpuMs - before.cpuMs : null;
    sample.sampledPeakRssBytes =
      Math.max(...[before, ...memory, after].filter(Boolean).map((value) => value.rssBytes)) ||
      null;
    report.samples.push(sample);
  }
  await verifyOutputs(server, sample, responses);
  console.log(
    `${run < 0 ? "warmup" : run + 1} ${server.variant} ${scenario}: ${sample.wallMs?.toFixed(1)} ms`,
  );
}

async function start(variant) {
  const server = launch(
    fixture,
    ["hub", "--days", String(days), "--port", "0", "--noOpen"],
    [variant.binary],
  );
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (server.child.exitCode !== null || server.child.signalCode !== null) {
        throw new Error(`Backend exited before startup: ${server.output().stderr.trim()}`);
      }
      const url = server.output().stdout.match(/http:\/\/\S+/)?.[0];
      if (url) return { ...server, origin: new URL(url).origin, variant: variant.name };
      await delay(25);
    }
    throw new Error("Timed out waiting for isolated backend startup");
  } catch (error) {
    await stop(server);
    throw error;
  }
}

async function homepage(server, scenario, run) {
  let sessions;
  let selectedWindow;
  await measure(server, scenario, run, async (request, sample, started, responses) => {
    const config = await request("config", "/api/config");
    selectedWindow = resolveTimeWindow(new URLSearchParams(), config.window, resolvedAt).window;
    sample.window = selectedWindow;
    const window = new URLSearchParams();
    if (selectedWindow.from != null)
      window.set("from", new Date(selectedWindow.from).toISOString());
    if (selectedWindow.to != null) window.set("to", new Date(selectedWindow.to).toISOString());
    const pricingWindow = days === 0 ? "days=0" : window.toString();
    const dashboardWindow =
      days === 0 ? new URLSearchParams({ days: "0" }) : new URLSearchParams(window);
    dashboardWindow.set("timeZone", timeZone);
    if (days === 0) dashboardWindow.set("to", new Date(resolvedAt).toISOString());
    const core = [
      request("agents", `/api/agents?${window}`),
      request("projects", `/api/projects?${window}&limit=100`),
      request("dashboard", `/api/dashboard?${dashboardWindow}`),
      request("bookmarks", "/api/bookmarks"),
    ];
    const projection = (async () => {
      sessions = [];
      let cursor;
      let pages = 0;
      do {
        const params = new URLSearchParams(window);
        params.set("limit", "250");
        if (cursor) params.set("cursor", cursor);
        const page = await request("sessions-page", `/api/sessions?${params}`);
        assert.ok(Array.isArray(page.sessions));
        sessions.push(...page.sessions);
        pages++;
        if (pages === 1) sample.firstSessionPageMs = performance.now() - started;
        cursor = page.nextCursor;
      } while (cursor);
      sample.sessions = sessions.length;
      sample.sessionPages = pages;
      sample.expectedSessions = activities.filter(
        (time) =>
          (selectedWindow.from == null || time >= selectedWindow.from) &&
          (selectedWindow.to == null || time <= selectedWindow.to),
      ).length;
      assert.equal(
        sessions.length,
        sample.expectedSessions,
        "Session projection must cover the full window",
      );
      assert.equal(
        new Set(sessions.map((session) => sessionRoutePath(session.reference))).size,
        sessions.length,
      );
      responses.set("session-projection", { body: { sessions } });
    })();
    const coreDone = Promise.all([...core, projection]).then(() => {
      sample.coreReadyMs = performance.now() - started;
    });
    await Promise.all([
      coreDone,
      request("pricing-unmatched", `/api/pricing/unmatched?${pricingWindow}`).then((pricing) => {
        assert.ok(Array.isArray(pricing.unmatchedModels));
        sample.unmatchedModels = pricing.unmatchedModels.length;
      }),
      request("pricing-overrides", "/api/pricing/overrides"),
    ]);
  });
  return { sessions, window: selectedWindow };
}

try {
  if (!values.snapshot) {
    console.log("Copying the cache through SQLite Backup API; source connection is read-only");
    await snapshotDatabase(values.database, join(fixture.root, ".codesesh/codesesh.db"));
    const state = join(dirname(values.database), "state.db");
    if (existsSync(state))
      await snapshotDatabase(state, join(fixture.env.CODESESH_STATE_DIR, "state.db"));
    const registry = join(dirname(values.database), "hub-control.db");
    if (existsSync(registry))
      await snapshotDatabase(registry, join(fixture.root, ".codesesh/hub-control.db"));
    const identity = join(dirname(values.database), "hub-identity");
    if (existsSync(identity)) copyFileSync(identity, join(fixture.root, ".codesesh/hub-identity"));
    const pricing = join(dirname(values.database), "models-dev-pricing.json");
    if (existsSync(pricing)) {
      const data = JSON.parse(readFileSync(pricing, "utf8"));
      data.timestamp = Date.now();
      writeFileSync(join(fixture.root, ".codesesh/models-dev-pricing.json"), JSON.stringify(data));
    }
  }
  const database = new DatabaseSync(join(fixture.root, ".codesesh/codesesh.db"), {
    readOnly: true,
  });
  report.dataset = database
    .prepare(
      "SELECT COUNT(*) AS sessions, SUM(message_count) AS headMessages, MAX(message_count) AS largestSession, COUNT(DISTINCT agent_name) AS agents FROM sessions",
    )
    .get();
  report.dataset.storedMessages = database
    .prepare("SELECT COUNT(*) AS count FROM messages")
    .get().count;
  activities = database
    .prepare("SELECT activity_time FROM sessions WHERE publication_id IS NULL")
    .all()
    .map((row) => row.activity_time);
  database.close();
  for (let run = -1; run < runs; run++) {
    for (const variant of run % 2 === 0 ? variants : [...variants].reverse()) {
      const server = await start(variant);
      try {
        const { sessions, window } = await homepage(server, "homepage-cold-catalog", run);
        await homepage(server, "homepage-warm-catalog", run);
        await measure(server, "search-and-detail", run, async (request, sample) => {
          const params = new URLSearchParams({ q: "error", limit: "50" });
          if (window.from != null) params.set("from", new Date(window.from).toISOString());
          if (window.to != null) params.set("to", new Date(window.to).toISOString());
          const search = await request("search-error", `/api/search?${params}`);
          assert.ok(Array.isArray(search.results));
          sample.searchResults = search.results.length;
          const target = [...sessions].sort(
            (a, b) => b.stats.message_count - a.stats.message_count,
          )[0];
          assert.ok(target, "No sessions in the selected window");
          const detail = await request(
            "detail-200",
            `/api/sessions${sessionRoutePath(target.reference)}?messageLimit=200`,
          );
          assert.ok(detail.messages.length > 0 && detail.messages.length <= 200);
          sample.detailMessages = detail.messages.length;
          sample.detailMessageTotal = detail.message_total;
          sample.detailHeadMessageCount = target.stats.message_count;
        });
      } finally {
        await stop(server);
      }
    }
  }
  const logDirectory = fixture.env.CODESESH_LOG_DIR;
  const requestIds = new Set(
    report.samples.flatMap((sample) => sample.requests.map((request) => request.requestId)),
  );
  for (const name of readdirSync(logDirectory)) {
    if (!name.endsWith(".log")) continue;
    for (const line of readFileSync(join(logDirectory, name), "utf8").trim().split("\n")) {
      const record = JSON.parse(line);
      if (record.event !== "perf.query" || !requestIds.has(record.request_id)) continue;
      report.queries.push(
        Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => key.endsWith("_ms") || ["request_id", "route", "cache_hit"].includes(key),
          ),
        ),
      );
    }
  }
} catch (error) {
  report.errors.push(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  ownedFixture.dispose();
  console.log(output);
}
