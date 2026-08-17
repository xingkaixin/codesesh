import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const startupUrlPath = process.env.CODESESH_E2E_STARTUP_URL_PATH;
if (!startupUrlPath) throw new Error("Missing CODESESH_E2E_STARTUP_URL_PATH");

rmSync(startupUrlPath, { force: true });

const child = spawn(process.execPath, ["packages/cli/dist/index.js", ...process.argv.slice(2)], {
  env: process.env,
  stdio: ["inherit", "pipe", "inherit"],
});
let output = "";
let captured = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (captured) return;

  output = `${output}${chunk}`.slice(-8_192);
  for (const match of output.matchAll(/https?:\/\/\S+/g)) {
    const url = new URL(match[0]);
    if (!url.searchParams.has("access_token")) continue;
    writeFileSync(startupUrlPath, url.href, { mode: 0o600 });
    captured = true;
    break;
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));
