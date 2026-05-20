import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, hasExplicitPortArg, parsePort } from "./ports.js";

describe("ports", () => {
  it("uses the default port when parsing fails", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort("abc")).toBe(DEFAULT_PORT);
  });

  it("detects explicit port arguments", () => {
    expect(hasExplicitPortArg(["--port", "8080"])).toBe(true);
    expect(hasExplicitPortArg(["--port=8080"])).toBe(true);
    expect(hasExplicitPortArg(["-p", "8080"])).toBe(true);
    expect(hasExplicitPortArg(["-p8080"])).toBe(true);
    expect(hasExplicitPortArg(["--agent", "codex"])).toBe(false);
  });
});
