import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeBinary = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../target/release",
  process.platform === "win32" ? "codesesh.exe" : "codesesh",
);
