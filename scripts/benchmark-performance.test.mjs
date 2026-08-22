import { describe, expect, it } from "vitest";
import {
  authenticatedApiUrl,
  benchmarkSessionPath,
  findStartupUrl,
} from "./benchmark-performance.mjs";

describe("performance benchmark authentication", () => {
  it("extracts the authenticated startup URL for the expected server", () => {
    const output = [
      "http://localhost:4000/?access_token=wrong-server",
      "  http://localhost:4521/?access_token=benchmark-secret",
    ].join("\n");

    expect(findStartupUrl(output, "http://localhost:4521")?.href).toBe(
      "http://localhost:4521/?access_token=benchmark-secret",
    );
  });

  it("carries the startup token into API probes", () => {
    const startupUrl = new URL("http://localhost:4521/?access_token=benchmark-secret");

    expect(authenticatedApiUrl(startupUrl, "/api/config").href).toBe(
      "http://localhost:4521/api/config?access_token=benchmark-secret",
    );
  });

  it("builds detail paths from canonical session references", () => {
    expect(
      benchmarkSessionPath({
        reference: { agentName: "Codex", sessionId: "opaque/id?#" },
      }),
    ).toBe("/codex/opaque%2Fid%3F%23");
  });
});
