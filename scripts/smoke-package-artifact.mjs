import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(executable, args, options) {
  const result = spawnSync(executable, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

async function waitFor(read, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode == null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function createCodexFixture(homeDir) {
  const fixtureDir = join(homeDir, ".codex", "sessions", "2026", "08", "08");
  mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = join(
    fixtureDir,
    "rollout-2026-08-08T07-00-00-019fdefe-bb8d-76f3-b988-770e6cc6a30d.jsonl",
  );
  const records = [
    {
      timestamp: "2026-08-08T07:00:00Z",
      type: "session_meta",
      payload: { cwd: join(homeDir, "project"), model: "gpt-5" },
    },
    {
      timestamp: "2026-08-08T07:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Artifact package smoke session" }],
      },
    },
    {
      timestamp: "2026-08-08T07:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        model: "gpt-5",
        content: [{ type: "output_text", text: "Artifact worker smoke completed" }],
      },
    },
  ];
  writeFileSync(fixturePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function assertInstalledManifest(manifest) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      assert(
        typeof value !== "string" || !value.startsWith("workspace:"),
        `Installed manifest leaked ${field}.${name}`,
      );
    }
  }
}

function verifyChecksum(tarballPath) {
  const checksumPath = `${tarballPath}.sha256`;
  assert(existsSync(checksumPath), `Artifact checksum is missing: ${checksumPath}`);
  const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  assert(actual === expected, `Artifact checksum mismatch for ${basename(tarballPath)}`);
}

async function smoke(tarballPath) {
  const smokeRoot = mkdtempSync(join(tmpdir(), "codesesh-package-smoke-"));
  const projectDir = join(smokeRoot, "project");
  const homeDir = join(smokeRoot, "home");
  let server;
  let stdout = "";
  let stderr = "";
  try {
    verifyChecksum(tarballPath);
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), '{"private":true}\n');
    const isolatedEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODESESH_LOG_DIR: join(smokeRoot, "logs"),
      npm_config_cache: join(smokeRoot, "npm-cache"),
    };
    run(command("npm"), ["install", "--omit=dev", "--no-audit", "--no-fund", tarballPath], {
      cwd: projectDir,
      env: isolatedEnv,
    });

    const packageDir = join(projectDir, "node_modules", "codesesh");
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    assertInstalledManifest(manifest);
    const cliPath = join(packageDir, manifest.bin.codesesh);
    assert(existsSync(cliPath), `Installed CLI entry is missing: ${cliPath}`);
    const installedBin = join(
      projectDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "codesesh.cmd" : "codesesh",
    );
    assert(
      run(installedBin, ["--version"], { env: isolatedEnv }) === manifest.version,
      "Installed CLI version does not match its manifest",
    );

    createCodexFixture(homeDir);
    server = spawn(installedBin, ["--port", "0", "--no-open", "--days", "0"], {
      cwd: projectDir,
      env: isolatedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    server.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const origin = await waitFor(
      () => stdout.match(/http:\/\/localhost:\d+/)?.[0],
      "the packaged CLI server",
    );
    const configResponse = await fetch(`${origin}/api/config`);
    assert(configResponse.ok, `Packaged API returned ${configResponse.status}`);
    await configResponse.json();

    await waitFor(async () => {
      const response = await fetch(`${origin}/api/sessions?days=0`);
      if (!response.ok) return false;
      return JSON.stringify(await response.json()).includes("Artifact package smoke session");
    }, "the scan and search-index workers");

    const htmlResponse = await fetch(origin);
    assert(htmlResponse.ok, `Packaged Web root returned ${htmlResponse.status}`);
    const html = await htmlResponse.text();
    const assetPath = html.match(/(?:src|href)=["'](\/assets\/[^"']+)["']/)?.[1];
    assert(assetPath, "Packaged Web HTML did not reference a hashed asset");
    const assetResponse = await fetch(new URL(assetPath, origin));
    assert(assetResponse.ok, `Packaged Web asset returned ${assetResponse.status}`);

    const databasePath = join(homeDir, ".cache", "codesesh", "codesesh.db");
    assert(existsSync(databasePath), "SQLite cache was not created by the packaged worker path");
    assert(statSync(databasePath).size > 0, "SQLite cache is empty");
    console.log(`Verified ${basename(tarballPath)} on Node ${process.versions.node}`);
  } catch (error) {
    if (stdout || stderr) console.error(`CLI output:\n${stdout}${stderr}`);
    throw error;
  } finally {
    if (server) await stopServer(server);
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

const tarballArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (!tarballArgument) {
  console.error("Usage: node scripts/smoke-package-artifact.mjs <codesesh.tgz>");
  process.exit(1);
}
const tarballPath = resolve(tarballArgument);
if (!existsSync(tarballPath)) {
  console.error(`Artifact not found: ${tarballPath}`);
  process.exit(1);
}

smoke(tarballPath).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
