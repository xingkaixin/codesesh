import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { npm, output, root, run, sha256, targetFor, version } from "./common.mjs";
import { createFixture, startServer, stop } from "../../tests/backend-contract/harness.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--contracts"))
  throw new Error("Usage: node scripts/rust/smoke.mjs [--contracts]");
const target = targetFor();
const dir = join(output, target.target);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
assert.equal(manifest.version, version);
const install = mkdtempSync(join(tmpdir(), "codesesh npm 中文 space "));
try {
  writeFileSync(
    join(install, "package.json"),
    JSON.stringify({ private: true, name: "codesesh-native-smoke", version: "0.0.0" }),
  );
  npm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      join(dir, manifest.platformPackage),
      join(dir, manifest.mainPackage),
    ],
    { cwd: install, stdio: "inherit" },
  );
  const installedPackage = join(install, "node_modules", target.package);
  const binary = join(installedPackage, "bin", target.executable);
  const launcher = join(install, "node_modules/codesesh/bin/codesesh.cjs");
  assert.equal(sha256(binary), manifest.binarySha256);
  const expectedVersion = run(binary, ["--version"], { cwd: install }).trim();
  assert.match(expectedVersion, new RegExp(`\\b${version.replaceAll(".", "\\.")}\\b`));
  assert.equal(
    run(process.execPath, [launcher, "--version"], { cwd: install }).trim(),
    expectedVersion,
  );
  assert.equal(
    npm(["exec", "--offline", "--", "codesesh", "--version"], { cwd: install }).trim(),
    expectedVersion,
  );
  assert.match(run(process.execPath, [launcher, "--help"], { cwd: install }), /Usage:/);
  const invalid = spawnSync(process.execPath, [launcher, "--codesesh-invalid-option"], {
    cwd: install,
    encoding: "utf8",
  });
  const directInvalid = spawnSync(binary, ["--codesesh-invalid-option"], {
    cwd: install,
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.status, directInvalid.status);
  let embeddedWebAssets = 0;
  if (process.argv.includes("--contracts")) {
    for (const command of [[binary], [process.execPath, launcher]]) {
      run(process.execPath, ["--test", "tests/backend-contract/backend.test.mjs"], {
        cwd: root,
        env: { ...process.env, CODESESH_BACKEND_COMMAND: JSON.stringify(command) },
        stdio: "inherit",
      });
      const fixture = createFixture();
      let server;
      try {
        server = await startServer(fixture, command);
        const page = await server.request("/");
        assert.equal(page.status, 200);
        assert.match(page.headers.get("content-type"), /text\/html/);
        const html = await page.text();
        assert.match(html, /id="root"/);
        const resources = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(
          (match) => match[1],
        );
        assert.ok(
          resources.some((path) => path.endsWith(".js")),
          "embedded JavaScript entry",
        );
        for (const path of new Set(resources)) {
          const response = await server.request(path);
          assert.equal(response.status, 200, path);
          assert.doesNotMatch(response.headers.get("content-type"), /text\/html/, path);
          assert.ok((await response.arrayBuffer()).byteLength > 0, path);
          embeddedWebAssets += 1;
        }
        const route = await server.request("/sessions/codex/native-install-check");
        assert.equal(route.status, 200);
        assert.equal(await route.text(), html);
      } finally {
        if (server) await stop(server);
        fixture.dispose();
      }
    }
  }
  renameSync(installedPackage, `${installedPackage}-missing`);
  const missing = spawnSync(process.execPath, [launcher, "--version"], {
    cwd: install,
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing @codesesh\/cli-/);
  const report = {
    version,
    target: target.target,
    binarySha256: manifest.binarySha256,
    node: process.version,
    npm: npm(["--version"]).trim(),
    verifiedAt: new Date().toISOString(),
    installScripts: false,
    contracts: process.argv.includes("--contracts"),
    embeddedWebAssets,
    passed: true,
  };
  writeFileSync(join(dir, "smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  rmSync(install, { recursive: true, force: true });
}
