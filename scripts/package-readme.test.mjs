import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("documents the remote access security contract in the published README", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../crates/codesesh-cli/README.md", import.meta.url)),
    "utf8",
  );
  for (const flag of [
    "--remote-access",
    "--tls-cert",
    "--tls-key",
    "--trust-proxy",
    "--public-url",
  ]) {
    expect(readme).toContain("`" + flag + "`");
  }
  expect(readme).toMatch(/enforces a loopback backend/i);
  expect(readme).toMatch(/cannot identify its sender/i);
  expect(readme).toMatch(/plaintext/i);
  expect(readme).toMatch(/X-Forwarded-Proto: https/);
});
