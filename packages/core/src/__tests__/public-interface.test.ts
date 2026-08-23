import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../index.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown> };

describe("core public interface", () => {
  it("exposes only the high-level scan operation at the package root", () => {
    expect(Object.keys(core)).toEqual(["scanSessions"]);
  });

  it("publishes focused runtime entry points without a catch-all", () => {
    expect(Object.keys(packageJson.exports).filter((path) => path.startsWith("./runtime"))).toEqual(
      [
        "./runtime/agents",
        "./runtime/analytics",
        "./runtime/diagnostics",
        "./runtime/discovery",
        "./runtime/pricing",
        "./runtime/projects",
        "./runtime/search",
        "./runtime/state",
      ],
    );
  });
});
