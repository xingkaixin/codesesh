import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createNativeArchive,
  extractArchive,
  npm,
  output,
  root,
  sha256,
  targetFor,
  targets,
  template,
  validateBinary,
  version,
} from "./common.mjs";

const target = targetFor(process.argv[2]);
if (process.argv.length > 4)
  throw new Error("Usage: node scripts/rust/pack.mjs [rust-target] [binary-path]");
const binary = process.argv[3]
  ? resolve(process.argv[3])
  : join(root, "target", target.target, "release", target.executable);
validateBinary(binary, target);
const dir = join(output, target.target);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const platform = join(dir, "platform");
mkdirSync(join(platform, "bin"), { recursive: true });
copyFileSync(binary, join(platform, "bin", target.executable));
chmodSync(join(platform, "bin", target.executable), 0o755);
const base = { version, license: "MIT", repository: "github:xingkaixin/codesesh" };
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
json(join(platform, "package.json"), {
  ...base,
  name: target.package,
  description: `CodeSesh native binary for ${target.platform}/${target.arch}`,
  os: [target.platform],
  cpu: [target.arch],
  files: ["bin"],
  ...(target.platform === "linux" ? { libc: ["glibc"] } : {}),
});
const cli = join(dir, "cli");
cpSync(template, cli, { recursive: true });
chmodSync(join(cli, "bin/codesesh.cjs"), 0o755);
copyFileSync(join(root, "crates/codesesh-cli/README.md"), join(cli, "README.md"));
json(join(cli, "package.json"), {
  ...base,
  name: "codesesh",
  description: "Browse local AI coding sessions",
  engines: { node: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node },
  bin: { codesesh: "bin/codesesh.cjs" },
  files: ["bin", "targets.json"],
  optionalDependencies: Object.fromEntries(targets.map((item) => [item.package, version])),
});
for (const path of [platform, cli]) copyFileSync(join(root, "LICENSE"), join(path, "LICENSE"));
const pack = (path) =>
  JSON.parse(npm(["pack", path, "--ignore-scripts", "--json", "--pack-destination", dir]))[0];
const nativePack = pack(platform);
nativePack.filename = nativePack.filename.replace(/^@/, "").replaceAll("/", "-");
const mainPack = pack(cli);
const archive = `codesesh-${version}-${target.target}.tar.gz`;
createNativeArchive(dir, archive, target.executable);
const verify = join(dir, "verify");
mkdirSync(verify);
extractArchive(dir, nativePack.filename, "verify");
extractArchive(dir, archive, "verify");
const hash = sha256(binary);
for (const path of [
  join(verify, "package/bin", target.executable),
  join(verify, target.executable),
]) {
  if (sha256(path) !== hash) throw new Error(`Archive binary hash mismatch: ${path}`);
}
rmSync(verify, { recursive: true });
const files = [nativePack.filename, mainPack.filename, archive].map((name) => ({
  name,
  sha256: sha256(join(dir, name)),
}));
json(join(dir, "manifest.json"), {
  version,
  target: target.target,
  binarySha256: hash,
  platformPackage: nativePack.filename,
  mainPackage: mainPack.filename,
  nativeArchive: archive,
  files,
});
writeFileSync(
  join(dir, "SHA256SUMS"),
  files.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
);
console.log(join(dir, "manifest.json"));
