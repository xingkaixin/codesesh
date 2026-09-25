#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const { dirname, join } = require("node:path");
const targets = require("../targets.json");
const manifest = require("../package.json");

function main() {
  const target = targets.find(
    (entry) => entry.platform === process.platform && entry.arch === process.arch,
  );
  if (!target)
    throw new Error(
      `Unsupported platform ${process.platform}/${process.arch}. Supported targets: ${targets.map((entry) => `${entry.platform}/${entry.arch}`).join(", ")}.`,
    );
  let packagePath;
  try {
    packagePath = require.resolve(`${target.package}/package.json`);
  } catch {
    throw new Error(
      `Missing ${target.package}@${manifest.version}. Reinstall codesesh with optional dependencies enabled; no compiler or install script is required.`,
    );
  }
  if (require(packagePath).version !== manifest.version)
    throw new Error(
      `Version mismatch: codesesh requires ${target.package}@${manifest.version}. Reinstall codesesh.`,
    );
  const child = spawn(join(dirname(packagePath), "bin", target.executable), process.argv.slice(2), {
    stdio: "inherit",
  });
  const signals =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  const cleanup = () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
  child.once("error", (error) => {
    cleanup();
    process.stderr.write(`codesesh: Cannot start ${target.package}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`codesesh: ${error.message}\n`);
  process.exitCode = 1;
}
