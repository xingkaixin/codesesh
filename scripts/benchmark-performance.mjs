#!/usr/bin/env node

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

function parseArgs(argv) {
  const options = {
    days: 7,
    iterations: 1,
    port: 0,
    timeoutMs: 120_000,
    headless: true,
    reactProfile: false,
    coldStart: false,
    target: "auto",
    navigation: "direct",
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
  if (!["auto", "latest", "smallest", "largest", "lightest", "heaviest"].includes(options.target)) {
    throw new Error("--target must be one of: auto, latest, smallest, largest, lightest, heaviest");
  }
  if (!["direct", "click"].includes(options.navigation)) {
    throw new Error("--navigation must be one of: direct, click");
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

    const { sessions } = await waitForWindowedSessions(url, options.timeoutMs);
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const windowLabel = options.days === 0 ? "all time" : `the last ${options.days} days`;
      const retryHint =
        options.days === 0
          ? "Check that local agent session paths are configured and contain sessions."
          : "Retry with a wider window, for example --days 365, or use --days 0 for all time.";
      throw new Error(`No sessions found in ${windowLabel}. ${retryHint}`);
    }
    console.log(`#${iteration} loaded ${sessions.length} windowed sessions`);

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

    const reactProfileEntries = options.reactProfile
      ? await withTimeout(
          page.evaluate(() => window.__CODESHESH_RENDER_PROFILE__ ?? []),
          2000,
          "React profile collection",
        ).catch(() => [])
      : [];
    if (options.reactProfile) {
      printReactProfileSummary(`#${iteration} React profile`, reactProfileEntries);
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
      reactProfileEntries,
      reactProfileSummary: summarizeReactProfile(reactProfileEntries),
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
