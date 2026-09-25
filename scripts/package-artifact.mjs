import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";
import { nativeBinary } from "./lib/native-command.mjs";
import { output, root, run, targetFor } from "./rust/common.mjs";

const pnpm = getPnpmInvocation();
run(pnpm.executable, ["build"], { shell: pnpm.shell, stdio: "inherit" });
const target = targetFor();
run(process.execPath, ["scripts/rust/pack.mjs", target.target, nativeBinary], { stdio: "inherit" });
const source = join(output, target.target);
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const destination = join(root, "artifacts/npm");
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const name of [...manifest.files.map((file) => file.name), "manifest.json", "SHA256SUMS"]) {
  copyFileSync(join(source, name), join(destination, name));
}
console.log(destination);
