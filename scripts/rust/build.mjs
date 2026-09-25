import { existsSync } from "node:fs";
import { join } from "node:path";
import { root, run, targetFor, validateBinary } from "./common.mjs";

const target = targetFor(process.argv[2]);
if (process.argv.length > 3) throw new Error("Usage: node scripts/rust/build.mjs [rust-target]");
if (!existsSync(join(root, "apps/web/dist/index.html")))
  throw new Error("Build the Web assets before building release binaries");
run(
  "cargo",
  ["build", "--release", "--locked", "--package", "codesesh-cli", "--target", target.target],
  { stdio: "inherit" },
);
const path = join(root, "target", target.target, "release", target.executable);
validateBinary(path, target);
console.log(path);
