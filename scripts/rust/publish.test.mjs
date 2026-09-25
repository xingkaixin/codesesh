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

test("publish all native packages and verify downloads before publishing main", async () => {
  const { packages, metadata, bytes } = fixture();
  const published = new Set();
  const events = [];
  await publishPackages(packages, {
    registry: {
      metadata: async (name) => {
        const item = packages.find((candidate) => candidate.name === name);
        return published.has(item.path) ? metadata(item) : null;
      },
      download: async (url) => {
        events.push(`download:${url.split("/").at(-1)}`);
        return bytes(url);
      },
    },
    publish: async (path) => {
      events.push(`publish:${path}`);
      published.add(path);
    },
    sleep: async () => assert.fail("No retry expected"),
  });
  assert.deepEqual(
    events,
    packages.flatMap(({ path }) => [`publish:${path}`, `download:${path}`]),
  );
});

test("rerun skips identical existing versions only after checking actual tarballs", async () => {
  const { packages, metadata, bytes } = fixture();
  let downloads = 0;
  await publishPackages(packages, {
    registry: {
      metadata: async (name) => metadata(packages.find((item) => item.name === name)),
      download: async (url) => {
        downloads++;
        return bytes(url);
      },
    },
    publish: async () => assert.fail("Existing version must not publish"),
  });
  assert.equal(downloads, 5);
});

test("existing integrity or tarball mismatch stops before any publication", async () => {
  const { packages, metadata, bytes } = fixture();
  for (const corruptMetadata of [true, false]) {
    let reads = 0;
    await assert.rejects(
      publishPackages(packages, {
        registry: {
          metadata: async () => {
            reads++;
            const found = metadata(packages[0]);
            if (corruptMetadata) found.dist.integrity = integrity(Buffer.from("different"));
            return found;
          },
          download: async (url) => (corruptMetadata ? bytes(url) : Buffer.from("different")),
        },
        publish: async () => assert.fail("Mismatch must not publish"),
        sleep: async () => assert.fail("Mismatch must not retry"),
      }),
      /(?:integrity|tarball) mismatch/,
    );
    assert.equal(reads, 1);
  }
});

test("bounded read retries wait for metadata and tarball visibility without republishing", async () => {
  const { packages, metadata, bytes } = fixture();
  let publishes = 0;
  let reads = 0;
  let downloads = 0;
  const delays = [];
  await publishPackages(packages.slice(0, 1), {
    registry: {
      metadata: async () => {
        reads++;
        if (reads === 1) throw new RegistryReadError("HTTP 503", true);
        if (reads <= 3) return null;
        return metadata(packages[0]);
      },
      download: async (url) => {
        if (++downloads === 1) throw new RegistryReadError("Tarball not visible", true);
        return bytes(url);
      },
    },
    publish: async () => {
      publishes++;
    },
    sleep: async (delay) => {
      delays.push(delay);
    },
    attempts: 4,
  });
  assert.equal(publishes, 1);
  assert.equal(reads, 5);
  assert.equal(downloads, 2);
  assert.deepEqual(delays, [1000, 1000, 2000]);
});

test("exhausted visibility reads prevent main publication", async () => {
  const { packages } = fixture();
  const published = [];
  let reads = 0;
  await assert.rejects(
    publishPackages(packages, {
      registry: {
        metadata: async () => {
          reads++;
          return null;
        },
        download: async () => assert.fail("No tarball available"),
      },
      publish: async (path) => {
        published.push(path);
      },
      sleep: async () => {},
      attempts: 3,
    }),
    /not yet visible/,
  );
  assert.deepEqual(published, [packages[0].path]);
  assert.equal(reads, 4);
});

test("failed or ambiguous publish is never retried", async () => {
  const { packages } = fixture();
  let publishes = 0;
  await assert.rejects(
    publishPackages(packages, {
      registry: {
        metadata: async () => null,
        download: async () => assert.fail("Publish failed"),
      },
      publish: async () => {
        publishes++;
        throw new Error("Connection lost during publish");
      },
      sleep: async () => assert.fail("Publish must not retry"),
    }),
    /Connection lost/,
  );
  assert.equal(publishes, 1);
});

test("registry authorization failure is not treated as an absent version", async () => {
  const { packages } = fixture();
  await assert.rejects(
    publishPackages(packages, {
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
