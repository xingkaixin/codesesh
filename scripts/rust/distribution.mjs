import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [releaseDirectory, destination] = process.argv.slice(2);
assert.ok(
  releaseDirectory && destination,
  "Usage: node scripts/rust/distribution.mjs <release-directory> <output-directory>",
);
const { version, manifests } = JSON.parse(
  readFileSync(join(releaseDirectory, "release-set.json"), "utf8"),
);
assert.match(version, /^\d+\.\d+\.\d+$/);
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];
const archives = targets.map((target) => {
  const name = `codesesh-${version}-${target}.tar.gz`;
  const manifest = manifests.find((item) => item.target === target);
  assert.equal(manifest?.version, version);
  assert.equal(manifest.nativeArchive, name);
  const expected = manifest.files.find((file) => file.name === name)?.sha256;
  const hash = createHash("sha256")
    .update(readFileSync(join(releaseDirectory, basename(name))))
    .digest("hex");
  assert.equal(hash, expected, `Checksum mismatch: ${name}`);
  return {
    name,
    hash,
    url: `https://github.com/xingkaixin/codesesh/releases/download/v${version}/${name}`,
  };
});
const [arm, intel, , windows] = archives;
mkdirSync(destination, { recursive: true });
writeFileSync(
  join(destination, "SHA256SUMS"),
  archives.map(({ name, hash }) => `${hash}  ${name}\n`).join(""),
);
writeFileSync(
  join(destination, "codesesh.rb"),
  `class Codesesh < Formula
  desc "Browse local AI coding sessions"
  homepage "https://codesesh.xingkaixin.me"
  version "${version}"
  license "MIT"

  depends_on :macos

  on_arm do
    url "${arm.url}"
    sha256 "${arm.hash}"
  end

  on_intel do
    url "${intel.url}"
    sha256 "${intel.hash}"
  end

  def install
    bin.install "codesesh"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/codesesh --version")
    assert_match "Usage:", shell_output("#{bin}/codesesh --help")
  end
end
`,
);
writeFileSync(
  join(destination, "codesesh.json"),
  `${JSON.stringify(
    {
      version,
      description: "Browse local AI coding sessions",
      homepage: "https://codesesh.xingkaixin.me",
      license: "MIT",
      architecture: { "64bit": { url: windows.url, hash: windows.hash } },
      bin: "codesesh.exe",
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Verified ${archives.length} release archives and generated distribution files for ${version}.`,
);
