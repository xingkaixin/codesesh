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
    }
  }

  if (!Number.isFinite(options.days) || options.days < 1) {
    throw new Error("--days must be a positive number");
  }
  if (!Number.isFinite(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive number");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout must be at least 1000ms");
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
  const summary = summarize(values);
  console.log(
    `${label}: avg ${formatMs(summary.avg)} | p50 ${formatMs(summary.p50)} | p95 ${formatMs(summary.p95)} | min ${formatMs(summary.min)} | max ${formatMs(summary.max)}`,
  );
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

function spawnCli(port, days) {
  const child = spawn(
    process.execPath,
    [cliPath, "--port", String(port), "--days", String(days), "--noOpen", "--no-cache"],
    {
      cwd: repoRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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
  for (const backup of [...activeCacheBackups]) {
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

async function runIteration(iteration, options) {
  const port = options.port || (await findFreePort());
  const url = `http://localhost:${port}`;
  const cacheBackup = moveCacheAside();
  let cli = null;
  let browser = null;

  try {
    const startedAt = performance.now();
    cli = spawnCli(port, options.days);

    await waitForServer(url, cli.child, options.timeoutMs);
    const serverReadyMs = performance.now() - startedAt;
    console.log(`#${iteration} server ready in ${formatMs(serverReadyMs)}`);

    browser = await launchBrowser(options.headless);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.locator('[data-testid="dashboard"]').waitFor({
      state: "visible",
      timeout: options.timeoutMs,
    });
    const dashboardReadyMs = performance.now() - startedAt;
    console.log(`#${iteration} dashboard visible in ${formatMs(dashboardReadyMs)}`);

    const { sessions } = await getWindowedSessions(url);
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error(`No sessions found in the last ${options.days} days`);
    }
    console.log(`#${iteration} loaded ${sessions.length} windowed sessions`);

    const target = sessions[0];
    const [agentKey, sessionId] = String(target.slug).split("/");
    const targetPath = `/${target.slug}`;
    const sessionApiPath = `/api/sessions/${agentKey}/${sessionId}`;
    console.log(`#${iteration} clicking ${targetPath}`);
    const clickStartedAt = performance.now();
    const responsePromise = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return path === sessionApiPath && response.ok();
    }, { timeout: options.timeoutMs });

    const clicked = await clickSessionLink(page, targetPath);
    console.log(`#${iteration} click dispatched`);
    if (!clicked) {
      throw new Error(`Session link not found: ${targetPath}`);
    }

    await responsePromise;
    console.log(`#${iteration} detail API returned`);
    await page.locator('[data-testid="session-detail"]').waitFor({
      state: "visible",
      timeout: options.timeoutMs,
    });
    const sessionClickMs = performance.now() - clickStartedAt;
    console.log(`#${iteration} session detail visible in ${formatMs(sessionClickMs)}`);

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
    restoreCache(cacheBackup);
  }
}

async function main() {
  if (!existsSync(cliPath)) {
    throw new Error(`Missing CLI build at ${cliPath}. Run pnpm build first.`);
  }

  const options = parseArgs(process.argv.slice(2));
  const results = [];

  console.log(
    `Running CodeSesh performance benchmark: days=${options.days}, iterations=${options.iterations}`,
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
  console.log("");
  console.log(JSON.stringify({ options, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
