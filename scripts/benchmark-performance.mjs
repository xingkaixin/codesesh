#!/usr/bin/env node

/**
 * End-to-end cold-start and navigation timings against a real browser.
 *
 * This reads the developer's own session data and measures wall-clock in a live
 * browser, so it is a local and nightly tool — not a PR gate. Its numbers move
 * with the machine and with whatever history happens to be on it, which is
 * exactly the kind of signal that makes a required check flaky.
 *
 * PR-time performance assurance lives in two other places:
 *   - deterministic gates in the unit tests (query counts, bundle bytes, cache
 *     cardinality), next to the code they protect
 *   - growth-rate checks in scripts/perf-scale.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cliPath = join(repoRoot, "packages/cli/dist/index.js");
const cacheDir = join(homedir(), ".cache", "codesesh");
const cacheFiles = ["codesesh.db", "codesesh.db-wal", "codesesh.db-shm", "scan-cache.json"];
const activeCacheBackups = new Set();
const PROFILE_SCENARIOS = ["typing", "sidebar", "live"];
const PROFILE_TYPING_TEXT = "performance-baseline";

function parseArgs(argv) {
  const options = {
    days: 7,
    iterations: 1,
    port: 0,
    timeoutMs: 120_000,
    headless: true,
    reactProfile: false,
    coldStart: false,
    fixtureSessions: 0,
    target: "auto",
    navigation: "direct",
    profileScenarios: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    }

    if (arg === "--days" && next) {
      options.days = Number(next);
      index += 1;
    } else if (arg === "--iterations" && next) {
      options.iterations = Number(next);
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--headed") {
      options.headless = false;
    } else if (arg === "--react-profile") {
      options.reactProfile = true;
    } else if (arg === "--cold") {
      options.coldStart = true;
    } else if (arg === "--target" && next) {
      options.target = next;
      index += 1;
    } else if (arg === "--navigation" && next) {
      options.navigation = next;
      index += 1;
    } else if (arg === "--profile-scenarios" && next) {
      options.profileScenarios = next.split(",").filter(Boolean);
      index += 1;
    } else if (arg === "--fixture-sessions" && next) {
      options.fixtureSessions = Number(next);
      index += 1;
    }
  }

  if (!Number.isFinite(options.days) || options.days < 0) {
    throw new Error("--days must be 0 or a positive number");
  }
  if (!Number.isFinite(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive number");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout must be at least 1000ms");
  }
  if (!Number.isInteger(options.fixtureSessions) || options.fixtureSessions < 0) {
    throw new Error("--fixture-sessions must be a non-negative integer");
  }
  if (!["auto", "latest", "smallest", "largest", "lightest", "heaviest"].includes(options.target)) {
    throw new Error("--target must be one of: auto, latest, smallest, largest, lightest, heaviest");
  }
  if (!["direct", "click"].includes(options.navigation)) {
    throw new Error("--navigation must be one of: direct, click");
  }
  if (options.profileScenarios.includes("all")) {
    options.profileScenarios = [...PROFILE_SCENARIOS];
  }
  if (options.profileScenarios.some((scenario) => !PROFILE_SCENARIOS.includes(scenario))) {
    throw new Error(`--profile-scenarios must contain only: ${PROFILE_SCENARIOS.join(", ")}, all`);
  }
  if (options.profileScenarios.length > 0 && !options.reactProfile) {
    throw new Error("--profile-scenarios requires --react-profile");
  }

  return options;
}

function formatMs(value) {
  return `${Math.round(value)}ms`;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: total / sorted.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
  };
}

function printSummary(label, values) {
  if (values.length === 0) {
    console.log(`${label}: no samples`);
    return;
  }

  const summary = summarize(values);
  console.log(
    `${label}: avg ${formatMs(summary.avg)} | p50 ${formatMs(summary.p50)} | p95 ${formatMs(summary.p95)} | min ${formatMs(summary.min)} | max ${formatMs(summary.max)}`,
  );
}

function summarizeReactProfile(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const id = String(entry.id ?? "unknown");
    const source = String(entry.source ?? "unknown");
    const key = `${source}:${id}`;
    const actualDuration = Number(entry.actualDuration);
    if (!Number.isFinite(actualDuration)) continue;

    const group = groups.get(key) ?? {
      id,
      source,
      commits: 0,
      totalActualDuration: 0,
      maxActualDuration: 0,
    };
    group.commits += 1;
    group.totalActualDuration += actualDuration;
    group.maxActualDuration = Math.max(group.maxActualDuration, actualDuration);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      avgActualDuration: group.totalActualDuration / group.commits,
    }))
    .sort((a, b) => b.totalActualDuration - a.totalActualDuration);
}

function printReactProfileSummary(label, entries) {
  if (entries.length === 0) {
    console.log(
      `${label}: no React profile entries. Confirm the served web bundle includes RenderProfiler and localStorage.codeseshProfiler is set.`,
    );
    return;
  }

  console.log(label);
  for (const group of summarizeReactProfile(entries).slice(0, 8)) {
    console.log(
      `  [${group.source}] ${group.id}: commits ${group.commits}, total ${formatMs(group.totalActualDuration)}, max ${formatMs(group.maxActualDuration)}, avg ${formatMs(group.avgActualDuration)}`,
    );
  }
}

async function collectReactProfileEntries(page) {
  return page.evaluate(() => {
    const entries = window.__CODESHESH_RENDER_PROFILE__ ?? [];
    window.__CODESHESH_RENDER_PROFILE__ = [];
    return entries;
  });
}

async function runProfileScenario(page, label, action) {
  await collectReactProfileEntries(page);
  const startedAt = performance.now();
  await action();
  await page.evaluate(
    () =>
      new Promise((resolvePromise) =>
        requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
      ),
  );
  const entries = await collectReactProfileEntries(page);
  const durationMs = performance.now() - startedAt;
  printReactProfileSummary(`React profile: ${label}`, entries);
  return {
    label,
    durationMs,
    entries,
    summary: summarizeReactProfile(entries),
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return typeof address === "object" && address ? address.port : 4521;
}

async function waitForServer(url, child, timeoutMs) {
  const startedAt = performance.now();
  let lastError = null;

  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`CLI exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${url}/api/config`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  const message = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${url}.${message}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopCli(child) {
  if (!child.pid || child.exitCode !== null) return;

  spawnSync("kill", ["-TERM", String(child.pid)]);
  sleepSync(300);

  if (isRunning(child.pid)) {
    spawnSync("kill", ["-KILL", String(child.pid)]);
  }
}

function spawnCli(port, days, coldStart) {
  const args = [cliPath, "--port", String(port), "--days", String(days), "--noOpen"];
  if (coldStart) args.push("--no-cache");

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  return { child, getOutput: () => output };
}

function moveCacheAside() {
  const backupDir = join(cacheDir, `.benchmark-backup-${process.pid}-${Date.now()}`);
  const moved = [];

  for (const name of cacheFiles) {
    const source = join(cacheDir, name);
    if (!existsSync(source)) continue;

    mkdirSync(backupDir, { recursive: true });
    const target = join(backupDir, name);
    renameSync(source, target);
    moved.push({ source, target });
  }

  const backup = { backupDir, moved, restored: false };
  activeCacheBackups.add(backup);
  return backup;
}

function restoreCache(backup) {
  if (backup.restored) return;
  backup.restored = true;
  activeCacheBackups.delete(backup);

  const { backupDir, moved } = backup;
  for (const name of cacheFiles) {
    rmSync(join(cacheDir, name), { force: true });
  }

  for (const { source, target } of moved) {
    if (existsSync(target)) {
      renameSync(target, source);
    }
  }

  rmSync(backupDir, { recursive: true, force: true });
}

function restoreActiveCaches() {
  for (const backup of activeCacheBackups) {
    restoreCache(backup);
  }
}

process.once("exit", restoreActiveCaches);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    restoreActiveCaches();
    process.kill(process.pid, signal);
  });
}

async function launchBrowser(headless) {
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

async function getWindowedSessions(url) {
  const response = await fetch(`${url}/api/sessions`);
  if (!response.ok) {
    throw new Error(`Failed to fetch sessions: ${response.status}`);
  }
  return response.json();
}

async function waitForWindowedSessions(url, timeoutMs) {
  const startedAt = performance.now();
  let lastResult = { sessions: [] };

  while (performance.now() - startedAt < timeoutMs) {
    lastResult = await getWindowedSessions(url);
    if (Array.isArray(lastResult.sessions) && lastResult.sessions.length > 0) {
      return lastResult;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  return lastResult;
}

function createFixtureData(sessionCount) {
  const now = Date.now();
  const agent = { name: "codex", displayName: "Codex", count: sessionCount };
  const project = {
    identityKind: "path",
    identityKey: "/benchmark/project",
    displayName: "benchmark/project",
    sources: ["/benchmark/project"],
    sessionCount,
    lastActivity: now,
    messages: sessionCount,
    tokens: sessionCount * 100,
    cost: 0,
    agentStats: [
      {
        name: "codex",
        sessions: sessionCount,
        messages: sessionCount,
        tokens: sessionCount * 100,
        cost: 0,
      },
    ],
  };
  const sessions = Array.from({ length: sessionCount }, (_, index) => {
    const id = `benchmark-${String(index).padStart(4, "0")}`;
    return {
      id,
      slug: `codex/${id}`,
      title: `Benchmark session ${index}`,
      directory: "/benchmark/project",
      project_identity: {
        kind: "path",
        key: project.identityKey,
        displayName: project.displayName,
      },
      time_created: now - index * 1_000,
      time_updated: now - index * 1_000,
      stats: {
        message_count: 1,
        total_input_tokens: 50,
        total_output_tokens: 50,
        total_cost: 0,
      },
    };
  });
  const dashboard = {
    totals: {
      sessions: sessionCount,
      messages: sessionCount,
      tokens: sessionCount * 100,
      cost: 0,
      costRecorded: 0,
      costEstimated: 0,
      cacheReadTokens: 0,
    },
    scopeCounts: { projects: 1, agents: 1 },
    perAgent: [
      {
        name: "codex",
        displayName: "Codex",
        sessions: sessionCount,
        messages: sessionCount,
        tokens: sessionCount * 100,
        cost: 0,
      },
    ],
    dailyActivity: [],
    modelDistribution: [],
    modelCost: null,
    perProject: [],
    projectRollup: { projects: 1, sessions: sessionCount, tokens: sessionCount * 100, cost: 0 },
    recentSessions: [],
    recentFileActivities: [],
    window: { days: 0, to: now },
  };
  const scanStatus = {
    type: "scan-status",
    active: false,
    phase: "idle",
    pendingAgents: [],
    scanningAgents: [],
    completedAgents: [],
    agentStatuses: {},
    totalAgents: 1,
    updatedAt: now,
    backfill: { active: false, pendingAgents: [], completedAgents: [], failedAgents: [] },
  };
  return { agent, dashboard, project, scanStatus, sessions };
}

function createFixtureSessionDetail(session) {
  return {
    ...session,
    reference: { agentName: "codex", sessionId: session.id },
    messages: [
      {
        id: `${session.id}-message`,
        role: "user",
        time_created: session.time_created,
        parts: [{ type: "text", text: session.title }],
      },
    ],
  };
}

async function installFixtureRoutes(context, fixture) {
  await context.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (pathname === "/api/config") return json({ window: { days: 0 } });
    if (pathname === "/api/agents") return json([fixture.agent]);
    if (pathname === "/api/projects") return json({ projects: [fixture.project] });
    if (pathname === "/api/dashboard") return json(fixture.dashboard);
    if (pathname === "/api/bookmarks") return json({ bookmarks: [] });
    if (pathname === "/api/status") return json(fixture.scanStatus);
    if (pathname === "/api/search") return json({ results: [] });
    if (pathname === "/api/logs") return json({});

    if (pathname === "/api/sessions") return json({ sessions: fixture.sessions });
    if (pathname.startsWith("/api/sessions/")) {
      const sessionId = decodeURIComponent(pathname.split("/").at(-1) ?? "");
      const session = fixture.sessions.find((candidate) => candidate.id === sessionId);
      return session
        ? json(createFixtureSessionDetail(session))
        : route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }

    return route.continue();
  });
}

async function installBenchmarkEventSource(context) {
  await context.addInitScript(() => {
    const sources = [];

    class BenchmarkEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      readyState = BenchmarkEventSource.OPEN;
      onopen = null;
      onerror = null;
      listeners = new Map();

      constructor() {
        sources.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      close() {
        this.readyState = BenchmarkEventSource.CLOSED;
      }
    }

    window.EventSource = BenchmarkEventSource;
    window.__CODESHESH_BENCHMARK_EMIT__ = (type, payload) => {
      const event = { data: JSON.stringify(payload) };
      for (const source of sources) {
        if (source.readyState !== BenchmarkEventSource.OPEN) continue;
        for (const listener of source.listeners.get(type) ?? []) listener(event);
      }
    };
  });
}

function getSessionMessageCount(session) {
  const value = Number(session?.stats?.message_count);
  return Number.isFinite(value) ? value : 0;
}

function getSessionTokenCount(session) {
  const stats = session?.stats ?? {};
  const total = Number(stats.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;

  const input = Number(stats.total_input_tokens);
  const output = Number(stats.total_output_tokens);
  const fallback = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  return fallback > 0 ? fallback : null;
}

function formatSessionTokenCount(session) {
  return getSessionTokenCount(session)?.toLocaleString("en-US") ?? "unknown";
}

function sortByKnownTokens(sessions) {
  const withTokens = sessions.filter((session) => getSessionTokenCount(session) != null);
  return withTokens.toSorted((a, b) => getSessionTokenCount(a) - getSessionTokenCount(b));
}

function selectBenchmarkTarget(sessions, targetMode) {
  if (targetMode === "latest") return sessions[0];

  const sortedByMessages = [...sessions].sort(
    (a, b) => getSessionMessageCount(a) - getSessionMessageCount(b),
  );
  if (targetMode === "smallest") return sortedByMessages[0];
  if (targetMode === "largest") return sortedByMessages[sortedByMessages.length - 1];

  const sortedByTokens = sortByKnownTokens(sessions);
  if (targetMode === "lightest") return sortedByTokens[0] ?? sortedByMessages[0];
  if (targetMode === "heaviest") {
    return (
      sortedByTokens[sortedByTokens.length - 1] ?? sortedByMessages[sortedByMessages.length - 1]
    );
  }

  const representative = sessions
    .filter((session) => {
      const count = getSessionMessageCount(session);
      const tokens = getSessionTokenCount(session);
      return count >= 20 && count <= 250 && (tokens == null || tokens <= 150_000);
    })
    .toSorted(
      (a, b) =>
        Math.abs(getSessionMessageCount(a) - 120) - Math.abs(getSessionMessageCount(b) - 120),
    );

  return representative[0] ?? sessions[0];
}

async function clickSessionLink(page, targetPath) {
  return page.evaluate((path) => {
    const link = [...document.querySelectorAll("a")].find((anchor) => {
      return new URL(anchor.href).pathname === path;
    });

    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  }, targetPath);
}

async function openSidebarProject(page, timeoutMs) {
  if (await page.locator("file-tree-container").count()) return;
  const projectLink = page.locator('aside a[href^="/projects/"]').first();
  await projectLink.waitFor({ state: "visible", timeout: timeoutMs });
  await projectLink.click();
  await page.locator("file-tree-container").waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator('input[name="session-search"]').blur();
}

function createLiveEvent(session, index, totalSessions) {
  const [agentName] = String(session.slug).split("/");
  const reference = { agentName, sessionId: session.id };
  return {
    type: "sessions-updated",
    changedAgents: [agentName],
    newSessions: 0,
    updatedSessions: 1,
    removedSessions: 0,
    totalSessions,
    timestamp: (session.time_updated ?? session.time_created) + index + 1,
    changedSessionHeads: [
      {
        reference,
        session: {
          ...session,
          display_title: `Benchmark live update ${index + 1}`,
          time_updated: (session.time_updated ?? session.time_created) + index + 1,
        },
      },
    ],
    projectionRelatedSessionHeads: [],
    projectionSessionOrder: [reference],
    removedSessionRefs: [],
  };
}

async function runProfileScenarios(page, sessions, options) {
  const results = [];

  for (const scenario of options.profileScenarios) {
    if (scenario === "typing") {
      const input = page.locator('input[name="session-search"]');
      await input.fill("");
      results.push(
        await runProfileScenario(page, "typing 20 characters", async () => {
          await input.pressSequentially(PROFILE_TYPING_TEXT);
        }),
      );
      continue;
    }

    if (scenario === "sidebar") {
      await openSidebarProject(page, options.timeoutMs);
      results.push(
        await runProfileScenario(page, "sidebar 20 j/k moves", async () => {
          await page.locator("body").click({ position: { x: 1_000, y: 800 } });
          for (let index = 0; index < 20; index += 1) {
            await page.keyboard.press(index % 2 === 0 ? "j" : "k");
          }
        }),
      );
      continue;
    }

    if (scenario === "live") {
      const session = sessions[0];
      if (!session) throw new Error("Live profiling requires at least one session");
      results.push(
        await runProfileScenario(page, "20 live update events", async () => {
          for (let index = 0; index < 20; index += 1) {
            const event = createLiveEvent(session, index, sessions.length);
            await page.evaluate((payload) => {
              if (!window.__CODESHESH_BENCHMARK_EMIT__) {
                throw new Error("Benchmark EventSource is not installed");
              }
              window.__CODESHESH_BENCHMARK_EMIT__("sessions-updated", payload);
            }, event);
            await page.waitForTimeout(550);
          }
        }),
      );
    }
  }

  return results;
}

async function waitForSessionDetailVisible(page, target, timeoutMs) {
  try {
    await withTimeout(
      page.waitForFunction(
        ({ title }) => {
          if (document.querySelector('[data-testid="session-detail"]')) return true;

          const normalizedTitle = String(title ?? "").trim();
          if (!normalizedTitle) return false;

          return [...document.querySelectorAll("h1,h2,h3")].some((element) =>
            element.textContent?.includes(normalizedTitle),
          );
        },
        { title: target.title },
        { timeout: timeoutMs },
      ),
      timeoutMs,
      "session detail UI",
    );
  } catch (error) {
    const diagnostics = await withTimeout(
      page.evaluate(() => ({
        url: window.location.href,
        bodyText: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) ?? "",
      })),
      1000,
      "session detail diagnostics",
    ).catch(() => ({
      url: "(unavailable)",
      bodyText: "(renderer did not respond to diagnostics)",
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Timed out waiting for session detail UI. ${message}\nURL: ${diagnostics.url}\nBody: ${diagnostics.bodyText}`,
    );
  }
}

async function runIteration(iteration, options) {
  const port = options.port || (await findFreePort());
  const url = `http://localhost:${port}`;
  const cacheBackup = options.coldStart ? moveCacheAside() : null;
  const fixture = options.fixtureSessions > 0 ? createFixtureData(options.fixtureSessions) : null;
  let cli = null;
  let browser = null;

  try {
    const startedAt = performance.now();
    cli = spawnCli(port, options.days, options.coldStart);

    await waitForServer(url, cli.child, options.timeoutMs);
    const serverReadyMs = performance.now() - startedAt;
    console.log(`#${iteration} server ready in ${formatMs(serverReadyMs)}`);

    browser = await launchBrowser(options.headless);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (fixture) await installFixtureRoutes(context, fixture);
    if (options.profileScenarios.includes("live")) await installBenchmarkEventSource(context);
    if (options.reactProfile) {
      await context.addInitScript(() => {
        window.localStorage.setItem("codeseshProfiler", "1");
      });
    }
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.locator('[data-testid="dashboard"]').waitFor({
      state: "visible",
      timeout: options.timeoutMs,
    });
    const dashboardReadyMs = performance.now() - startedAt;
    console.log(`#${iteration} dashboard visible in ${formatMs(dashboardReadyMs)}`);

    const { sessions } = fixture ?? (await waitForWindowedSessions(url, options.timeoutMs));
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const windowLabel = options.days === 0 ? "all time" : `the last ${options.days} days`;
      const retryHint =
        options.days === 0
          ? "Check that local agent session paths are configured and contain sessions."
          : "Retry with a wider window, for example --days 365, or use --days 0 for all time.";
      throw new Error(`No sessions found in ${windowLabel}. ${retryHint}`);
    }
    console.log(`#${iteration} loaded ${sessions.length} windowed sessions`);

    const profileScenarios =
      options.profileScenarios.length > 0 ? await runProfileScenarios(page, sessions, options) : [];

    const target = selectBenchmarkTarget(sessions, options.target);
    const [agentKey, sessionId] = String(target.slug).split("/");
    const targetPath = `/${target.slug}`;
    const sessionApiPath = `/api/sessions/${agentKey}/${sessionId}`;
    console.log(
      `#${iteration} opening ${targetPath} (${getSessionMessageCount(target)} messages, ${formatSessionTokenCount(target)} tokens, target=${options.target}, navigation=${options.navigation})`,
    );
    const clickStartedAt = performance.now();

    if (options.navigation === "click") {
      const responsePromise = page.waitForResponse(
        (response) => {
          const path = new URL(response.url()).pathname;
          return path === sessionApiPath && response.ok();
        },
        { timeout: options.timeoutMs },
      );

      const clicked = await clickSessionLink(page, targetPath);
      console.log(`#${iteration} click dispatched`);
      if (!clicked) {
        throw new Error(`Session link not found: ${targetPath}`);
      }

      await responsePromise;
    } else {
      const responsePromise = page.waitForResponse(
        (response) => {
          const path = new URL(response.url()).pathname;
          return path === sessionApiPath && response.ok();
        },
        { timeout: options.timeoutMs },
      );

      await page.goto(`${url}${targetPath}`, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });
      await responsePromise;
    }

    console.log(`#${iteration} detail API returned`);
    await waitForSessionDetailVisible(page, target, options.timeoutMs);
    const sessionClickMs = performance.now() - clickStartedAt;
    console.log(`#${iteration} session detail visible in ${formatMs(sessionClickMs)}`);

    const navigationReactProfileEntries = options.reactProfile
      ? await withTimeout(collectReactProfileEntries(page), 2000, "React profile collection").catch(
          () => [],
        )
      : [];
    if (options.reactProfile) {
      printReactProfileSummary(
        `#${iteration} navigation React profile`,
        navigationReactProfileEntries,
      );
    }

    await browser.close();
    browser = null;
    console.log(`#${iteration} browser closed`);
    stopCli(cli.child);
    console.log(`#${iteration} CLI stopped`);

    return {
      iteration,
      sessions: sessions.length,
      target: target.slug,
      serverReadyMs,
      dashboardReadyMs,
      sessionClickMs,
      profileScenarios,
      reactProfileEntries: navigationReactProfileEntries,
      reactProfileSummary: summarizeReactProfile(navigationReactProfileEntries),
    };
  } catch (error) {
    const output = cli?.getOutput() ?? "";
    if (output.trim()) {
      console.error(output.trim());
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
    if (cli) {
      stopCli(cli.child);
    }
    if (cacheBackup) restoreCache(cacheBackup);
  }
}

async function main() {
  if (!existsSync(cliPath)) {
    throw new Error(`Missing CLI build at ${cliPath}. Run pnpm build first.`);
  }

  const options = parseArgs(process.argv.slice(2));
  const results = [];

  console.log(
    `Running CodeSesh performance benchmark: days=${options.days}, iterations=${options.iterations}, cold=${options.coldStart}, target=${options.target}, navigation=${options.navigation}`,
  );

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const result = await runIteration(iteration, options);
    results.push(result);
    console.log(
      `#${iteration} cold start ${formatMs(result.dashboardReadyMs)}, click detail ${formatMs(result.sessionClickMs)} (${result.sessions} sessions)`,
    );
  }

  console.log("");
  printSummary(
    "Cold CLI start to visible dashboard",
    results.map((result) => result.dashboardReadyMs),
  );
  printSummary(
    "Click session to visible detail",
    results.map((result) => result.sessionClickMs),
  );
  if (options.reactProfile) {
    printReactProfileSummary(
      "Combined React profile",
      results.flatMap((result) => result.reactProfileEntries),
    );
  }
  console.log("");
  console.log(JSON.stringify({ options, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
