import assert from "node:assert/strict";
import { test } from "node:test";
import { integrity, publishPackages, RegistryReadError } from "./publish.mjs";

function fixture() {
  const names = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "codesesh"];
  const packages = names.map((name) => ({
    name: name === "codesesh" ? name : `@codesesh/cli-${name}`,
    version: "1.2.3",
    path: `${name}.tgz`,
    integrity: integrity(Buffer.from(name)),
  }));
  const metadata = (item) => ({
    name: item.name,
    version: item.version,
    dist: { integrity: item.integrity, tarball: `https://registry.npmjs.org/${item.path}` },
  });
  const bytes = (url) =>
    Buffer.from(
      url
        .split("/")
        .at(-1)
        .replace(/\.tgz$/, ""),
    );
  return { packages, metadata, bytes };
}

function clock() {
  let elapsed = 0;
  const delays = [];
  const logs = [];
  return {
    delays,
    logs,
    now: () => elapsed,
    sleep: async (delay) => {
      delays.push(delay);
      elapsed += delay;
    },
    log: (message) => logs.push(message),
  };
}

test("uploads every platform before polling and waits before each visibility phase", async () => {
  const { packages, metadata, bytes } = fixture();
  const time = clock();
  const published = new Set();
  const events = [];
  await publishPackages(packages, {
    ...time,
    registry: {
      metadata: async (name) => {
        const item = packages.find((candidate) => candidate.name === name);
        if (!published.has(item.path)) return null;
        events.push(`read:${item.path}:${time.now()}`);
        return metadata(item);
      },
      download: async (url) => bytes(url),
    },
    publish: async (path) => {
      events.push(`publish:${path}:${time.now()}`);
      published.add(path);
    },
  });
  assert.deepEqual(events, [
    ...packages.slice(0, 4).map(({ path }) => `publish:${path}:0`),
    ...packages.slice(0, 4).map(({ path }) => `read:${path}:10000`),
    "publish:codesesh.tgz:10000",
    "read:codesesh.tgz:20000",
  ]);
  assert.deepEqual(time.delays, [10_000, 10_000]);
});

test("rerun verifies existing tarballs and publishes only missing packages", async () => {
  const { packages, metadata, bytes } = fixture();
  for (const existingCount of [2, 5]) {
    const existing = new Set(packages.slice(0, existingCount).map((item) => item.path));
    const published = [];
    const downloads = [];
    await publishPackages(packages, {
      ...clock(),
      registry: {
        metadata: async (name) => {
          const item = packages.find((candidate) => candidate.name === name);
          return existing.has(item.path) ? metadata(item) : null;
        },
        download: async (url) => {
          downloads.push(url);
          return bytes(url);
        },
      },
      publish: async (path) => {
        published.push(path);
        existing.add(path);
      },
    });
    assert.deepEqual(
      published,
      packages.slice(existingCount).map((item) => item.path),
    );
    assert.equal(downloads.length, 5);
  }
});

test("preflight rejects a later existing package mismatch before any publication", async () => {
  const { packages, metadata, bytes } = fixture();
  for (const corruptMetadata of [true, false]) {
    await assert.rejects(
      publishPackages(packages, {
        ...clock(),
        registry: {
          metadata: async (name) => {
            if (name !== packages[3].name) return null;
            const found = metadata(packages[3]);
            if (corruptMetadata) found.dist.integrity = integrity(Buffer.from("different"));
            return found;
          },
          download: async (url) => (corruptMetadata ? bytes(url) : Buffer.from("different")),
        },
        publish: async () => assert.fail("Mismatch must not publish"),
      }),
      /(?:integrity|tarball) mismatch/,
    );
  }
});

test("polls only pending packages through transient errors without republishing", async () => {
  const { packages, metadata, bytes } = fixture();
  const time = clock();
  const published = new Set();
  const downloads = new Map();
  let preflightFailed = false;
  await publishPackages(packages, {
    ...time,
    registry: {
      metadata: async (name) => {
        if (!preflightFailed) {
          preflightFailed = true;
          throw new RegistryReadError("HTTP 503", true);
        }
        const item = packages.find((candidate) => candidate.name === name);
        if (!published.has(item.path)) return null;
        if (item === packages[0] && time.now() < 40_000) return null;
        if (item === packages[0] && time.now() < 50_000)
          throw new RegistryReadError("HTTP 429", true);
        return metadata(item);
      },
      download: async (url) => {
        downloads.set(url, (downloads.get(url) ?? 0) + 1);
        if (url.endsWith(packages[0].path) && time.now() < 60_000)
          throw new RegistryReadError("Tarball not visible", true);
        return bytes(url);
      },
    },
    publish: async (path) => {
      assert.ok(!published.has(path));
      published.add(path);
    },
  });
  assert.equal(published.size, 5);
  assert.equal(time.now(), 70_000);
  for (const item of packages.slice(1)) assert.equal(downloads.get(metadata(item).dist.tarball), 1);
  assert.ok(time.logs.some((line) => line.includes("HTTP 429")));
});

test("platforms share one five-minute deadline and timeout prevents main publication", async () => {
  const { packages } = fixture();
  const time = clock();
  const published = [];
  await assert.rejects(
    publishPackages(packages, {
      ...time,
      registry: {
        metadata: async () => null,
        download: async () => assert.fail("No tarball available"),
      },
      publish: async (path) => published.push(path),
    }),
    (error) => {
      assert.match(error.message, /Timed out after 5 minutes.*Platform packages: 300s/);
      for (const item of packages.slice(0, 4)) assert.ok(error.message.includes(item.name));
      assert.match(error.message, /not yet visible/);
      return true;
    },
  );
  assert.deepEqual(
    published,
    packages.slice(0, 4).map((item) => item.path),
  );
  assert.equal(time.now(), 300_000);
});

test("main gets its own deadline after slow platform visibility", async () => {
  const { packages, metadata, bytes } = fixture();
  const time = clock();
  const published = new Set();
  await assert.rejects(
    publishPackages(packages, {
      ...time,
      registry: {
        metadata: async (name) => {
          const item = packages.find((candidate) => candidate.name === name);
          if (!published.has(item.path) || time.now() < 290_000 || name === "codesesh") return null;
          return metadata(item);
        },
        download: async (url) => bytes(url),
      },
      publish: async (path) => published.add(path),
    }),
    /Timed out after 5 minutes.*Main package: 300s.*codesesh@1.2.3/,
  );
  assert.equal(time.now(), 590_000);
  assert.equal(published.size, 5);
});

test("request time counts toward the deadline and late success cannot publish main", async () => {
  const { packages, metadata, bytes } = fixture();
  const time = clock();
  const published = [];
  await assert.rejects(
    publishPackages(packages, {
      ...time,
      registry: {
        metadata: async (name, version, signal) => {
          assert.ok(signal instanceof AbortSignal);
          if (published.length === 0) return null;
          await time.sleep(290_000);
          return metadata(packages.find((item) => item.name === name));
        },
        download: async (url, signal) => {
          assert.ok(signal instanceof AbortSignal);
          return bytes(url);
        },
      },
      publish: async (path) => published.push(path),
    }),
    /Timed out after 5 minutes/,
  );
  assert.equal(time.now(), 300_000);
  assert.equal(published.length, 4);
});

test("failed or ambiguous publish is never retried", async () => {
  const { packages } = fixture();
  let publishes = 0;
  await assert.rejects(
    publishPackages(packages, {
      ...clock(),
      registry: {
        metadata: async () => null,
        download: async () => assert.fail("Publish failed"),
      },
      publish: async () => {
        publishes++;
        throw new Error("Connection lost during publish");
      },
    }),
    /Connection lost/,
  );
  assert.equal(publishes, 1);
});

test("registry authorization failure is not treated as an absent version", async () => {
  const { packages } = fixture();
  await assert.rejects(
    publishPackages(packages, {
      ...clock(),
      registry: {
        metadata: async () => {
          throw new RegistryReadError("HTTP 403", false);
        },
        download: async () => assert.fail("Registry rejected read"),
      },
      publish: async () => assert.fail("Registry rejected read"),
      sleep: async () => assert.fail("Permanent read failure must not retry"),
    }),
    /HTTP 403/,
  );
});
