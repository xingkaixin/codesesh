import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { npm, output, targets, version } from "./common.mjs";

export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export class RegistryReadError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

async function request(url, signal, read) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new RegistryReadError(
        `Registry returned HTTP ${response.status}: ${url}`,
        response.status === 429 || response.status >= 500,
      );
    }
    return await read(response);
  } catch (cause) {
    if (cause instanceof RegistryReadError) throw cause;
    throw new RegistryReadError(`Registry request failed: ${cause.message}`, true);
  }
}

export const registry = {
  async metadata(name, packageVersion, signal) {
    return request(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(packageVersion)}`,
      signal,
      (response) => response.json(),
    );
  },
  async download(url, signal) {
    assert.equal(new URL(url).protocol, "https:", "Registry tarball must use HTTPS");
    const bytes = await request(url, signal, async (response) =>
      Buffer.from(await response.arrayBuffer()),
    );
    if (!bytes) throw new RegistryReadError(`Tarball is not yet visible: ${url}`, true);
    return bytes;
  },
};

export async function publishPackages(packages, options = {}) {
  const main = packages.find((item) => item.name === "codesesh");
  const platforms = packages.filter((item) => item.name !== "codesesh");
  assert.ok(main && platforms.length > 0 && platforms.length === packages.length - 1);
  const client = options.registry ?? registry;
  const publish =
    options.publish ??
    ((path) => npm(["publish", path, "--provenance", "--access", "public"], { stdio: "inherit" }));
  const sleep = options.sleep ?? setTimeout;
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? console.log;

  async function poll(items, label, check, delayFirst = false) {
    if (items.length === 0) return;
    const started = now();
    const deadline = started + 300_000;
    const pending = new Map(items.map((item) => [item, "Not checked yet"]));
    const status = () =>
      `${label}: ${Math.round((now() - started) / 1000)}s elapsed; pending: ${[...pending]
        .map(([item, error]) => `${item.name}@${item.version} (${error})`)
        .join(", ")}`;
    if (delayFirst) await sleep(10_000);
    while (now() < deadline) {
      for (const item of pending.keys()) {
        if (now() >= deadline) break;
        const signal = AbortSignal.timeout(Math.ceil(deadline - now()));
        try {
          await check(item, signal);
          if (now() >= deadline) break;
          pending.delete(item);
          log(`${label}: checked ${item.name}@${item.version}`);
        } catch (error) {
          if (!(error instanceof RegistryReadError) || !error.retryable) throw error;
          pending.set(item, error.message);
        }
      }
      if (pending.size === 0) return;
      log(status());
      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(10_000, remaining));
    }
    throw new Error(`Timed out after 5 minutes. ${status()}`);
  }

  async function verify(item, metadata, signal) {
    assert.equal(metadata.name, item.name, "Registry package name mismatch");
    assert.equal(metadata.version, item.version, "Registry package version mismatch");
    assert.equal(
      metadata.dist?.integrity,
      item.integrity,
      `${item.name}: registry integrity mismatch`,
    );
    const downloaded = await client.download(metadata.dist.tarball, signal);
    assert.equal(
      integrity(downloaded),
      item.integrity,
      `${item.name}: downloaded tarball mismatch`,
    );
  }

  const existing = new Set();
  await poll(packages, "Check existing versions", async (item, signal) => {
    const metadata = await client.metadata(item.name, item.version, signal);
    if (!metadata) return;
    await verify(item, metadata, signal);
    existing.add(item);
  });

  for (const [label, items] of [
    ["Platform packages", platforms],
    ["Main package", [main]],
  ]) {
    const missing = items.filter((item) => !existing.has(item));
    for (const item of missing) await publish(item.path);
    await poll(
      missing,
      label,
      async (item, signal) => {
        const metadata = await client.metadata(item.name, item.version, signal);
        if (!metadata) throw new RegistryReadError("Published version is not yet visible", true);
        await verify(item, metadata, signal);
      },
      true,
    );
  }
}

export function releasePackages() {
  const release = JSON.parse(readFileSync(join(output, "release-set.json"), "utf8"));
  assert.equal(release.version, version);
  assert.equal(release.manifests.length, targets.length);
  const packages = [];
  let main;
  for (const target of targets) {
    const matching = release.manifests.filter((manifest) => manifest.target === target.target);
    assert.equal(matching.length, 1, `Missing or duplicate target ${target.target}`);
    const manifest = matching[0];
    assert.equal(manifest.version, version);
    const readPackage = (name, filename) => {
      assert.ok(filename && !filename.includes("/") && !filename.includes("\\"));
      const path = join(output, target.target, filename);
      const bytes = readFileSync(path);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        manifest.files.find((file) => file.name === filename)?.sha256,
        `${filename}: local artifact changed after verification`,
      );
      return { name, version, path, integrity: integrity(bytes) };
    };
    packages.push(readPackage(target.package, manifest.platformPackage));
    const candidate = readPackage("codesesh", manifest.mainPackage);
    if (main)
      assert.equal(candidate.integrity, main.integrity, "Main packages differ across targets");
    else main = candidate;
  }
  assert.ok(main);
  return [...packages, main];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, "Usage: node scripts/rust/publish.mjs");
  await publishPackages(releasePackages());
}
