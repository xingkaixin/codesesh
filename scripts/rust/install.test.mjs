import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const installer = resolve("apps/www/public/install.sh");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codesesh install 测试 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const assets = join(root, "assets");
  const destination = join(root, "install", "codesesh");
  mkdirSync(bin);
  mkdirSync(assets);
  const executable = (name, content) => {
    writeFileSync(name, content);
    chmodSync(name, 0o755);
  };
  executable(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',
  );
  executable(
    join(bin, "curl"),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */latest) printf 'https://github.com/xingkaixin/codesesh/releases/tag/v1.1.1';;
  *) cp "$TEST_ASSETS/$(basename "$url")" "$output";;
esac
`,
  );
  executable(join(assets, "codesesh"), '#!/bin/sh\necho "codesesh 1.1.1"\n');
  const name = "codesesh-1.1.1-aarch64-apple-darwin.tar.gz";
  execFileSync("tar", ["-czf", join(assets, name), "-C", assets, "codesesh"]);
  const hash = createHash("sha256")
    .update(readFileSync(join(assets, name)))
    .digest("hex");
  writeFileSync(join(assets, "SHA256SUMS"), `${hash}  ${name}\n`);
  const run = (env = {}) =>
    spawnSync("sh", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODESESH_VERSION: "",
        CODESESH_INSTALL_DIR: join(root, "install"),
        PATH: `${bin}:${process.env.PATH}`,
        TEST_ASSETS: assets,
        ...env,
      },
    });
  return { root, bin, assets, destination, run, executable };
}

test("installs latest into a path with spaces and leaves a current installation intact", (t) => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    execFileSync(f.destination, ["--version"], { encoding: "utf8" }).trim(),
    "codesesh 1.1.1",
  );
  rmSync(join(f.assets, "SHA256SUMS"));
  result = f.run({ CODESESH_VERSION: "v1.1.1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/);
});

test("failed download and checksum mismatch preserve the old executable", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "install"));
  const old = '#!/bin/sh\necho "codesesh 1.0.0"\n';
  f.executable(f.destination, old);
  writeFileSync(
    join(f.assets, "SHA256SUMS"),
    `${"0".repeat(64)}  codesesh-1.1.1-aarch64-apple-darwin.tar.gz\n`,
  );
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.destination, "utf8"), old);
  rmSync(join(f.assets, "SHA256SUMS"));
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.destination, "utf8"), old);
});

test("updates an older executable only after successful verification", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "install"));
  f.executable(f.destination, '#!/bin/sh\necho "codesesh 1.0.0"\n');
  const result = f.run({ CODESESH_VERSION: "1.1.1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.destination, "utf8"), /1\.1\.1/);
});

test("a checksummed executable that cannot run does not replace the old version", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "install"));
  const old = '#!/bin/sh\necho "codesesh 1.0.0"\n';
  f.executable(f.destination, old);
  f.executable(join(f.assets, "codesesh"), "#!/bin/sh\nexit 1\n");
  const name = "codesesh-1.1.1-aarch64-apple-darwin.tar.gz";
  execFileSync("tar", ["-czf", join(f.assets, name), "-C", f.assets, "codesesh"]);
  const hash = createHash("sha256")
    .update(readFileSync(join(f.assets, name)))
    .digest("hex");
  writeFileSync(join(f.assets, "SHA256SUMS"), `${hash}  ${name}\n`);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.destination, "utf8"), old);
});

test("refuses package-manager symlinks and unsupported platforms", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "install"));
  symlinkSync(join(f.assets, "codesesh"), f.destination);
  assert.match(f.run().stderr, /Refusing to replace a symlink/);
  f.executable(join(f.bin, "uname"), "#!/bin/sh\necho unsupported\n");
  assert.match(f.run().stderr, /Supported platforms/);
});

test("rejects old glibc before downloading", (t) => {
  const f = fixture(t);
  f.executable(
    join(f.bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
  );
  f.executable(join(f.bin, "getconf"), '#!/bin/sh\necho "glibc 2.31"\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /glibc 2.35/);
});

test("distribution manifests use verified archives and reject tampering", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codesesh-distribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targets = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
  ];
  const version = "1.1.1";
  const manifests = targets.map((target) => {
    const name = `codesesh-${version}-${target}.tar.gz`;
    writeFileSync(join(root, name), target);
    return {
      version,
      target,
      nativeArchive: name,
      files: [{ name, sha256: createHash("sha256").update(target).digest("hex") }],
    };
  });
  writeFileSync(join(root, "release-set.json"), JSON.stringify({ version, manifests }));
  const args = ["scripts/rust/distribution.mjs", root, join(root, "output")];
  assert.equal(spawnSync(process.execPath, args).status, 0);
  const scoop = JSON.parse(readFileSync(join(root, "output/codesesh.json"), "utf8"));
  assert.equal(scoop.architecture["64bit"].hash, manifests[3].files[0].sha256);
  assert.match(readFileSync(join(root, "output/codesesh.rb"), "utf8"), /depends_on :macos/);
  writeFileSync(join(root, manifests[0].nativeArchive), "corrupt");
  assert.notEqual(spawnSync(process.execPath, args).status, 0);
});
