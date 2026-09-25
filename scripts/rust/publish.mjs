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

async function request(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (cause) {
    throw new RegistryReadError(`Registry request failed: ${cause.message}`, true);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new RegistryReadError(
      `Registry returned HTTP ${response.status}: ${url}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

export const registry = {
  async metadata(name, packageVersion) {
    const response = await request(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(packageVersion)}`,
    );
    return response ? response.json() : null;
  },
  async download(url) {
    assert.equal(new URL(url).protocol, "https:", "Registry tarball must use HTTPS");
    const response = await request(url);
    if (!response) throw new RegistryReadError(`Tarball is not yet visible: ${url}`, true);
    return Buffer.from(await response.arrayBuffer());
  },
};

export async function publishPackages(packages, options = {}) {
  const client = options.registry ?? registry;
  const publish =
    options.publish ??
    ((path) => npm(["publish", path, "--provenance", "--access", "public"], { stdio: "inherit" }));
  const sleep = options.sleep ?? setTimeout;
  const attempts = options.attempts ?? 6;
  assert.ok(Number.isInteger(attempts) && attempts > 0);

  async function retryRead(read) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof RegistryReadError) || !error.retryable || attempt + 1 >= attempts)
          throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  async function verify(item, metadata) {
    assert.equal(metadata.name, item.name, "Registry package name mismatch");
    assert.equal(metadata.version, item.version, "Registry package version mismatch");
    assert.equal(
      metadata.dist?.integrity,
      item.integrity,
      `${item.name}: registry integrity mismatch`,
    );
    const downloaded = await client.download(metadata.dist.tarball);
    assert.equal(
      integrity(downloaded),
      item.integrity,
      `${item.name}: downloaded tarball mismatch`,
    );
  }

  for (const item of packages) {
    const existing = await retryRead(() => client.metadata(item.name, item.version));
    if (existing) {
      await retryRead(() => verify(item, existing));
      continue;
    }
    await publish(item.path);
    await retryRead(async () => {
      const metadata = await client.metadata(item.name, item.version);
      if (!metadata)
        throw new RegistryReadError(`${item.name}: published version is not yet visible`, true);
      await verify(item, metadata);
    });
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
