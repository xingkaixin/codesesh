import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { nativeBinary } from "./lib/native-command.mjs";

if (!existsSync(nativeBinary)) {
  console.error(`Native backend is missing: ${nativeBinary}. Run pnpm build first.`);
  process.exit(1);
}
const child = spawn(nativeBinary, process.argv.slice(2), { stdio: "inherit" });
const signals =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = signals.map((signal) => {
  const handler = () => child.kill(signal);
  process.on(signal, handler);
  return [signal, handler];
});
const cleanup = () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
child.once("error", (error) => {
  cleanup();
  console.error(`Cannot start the native backend: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  cleanup();
  process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
});
