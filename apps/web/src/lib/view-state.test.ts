import { describe, expect, it } from "vitest";
import { parseViewState } from "./view-state";

const agents = new Set(["claudecode", "codex"]);

describe("parseViewState", () => {
  it("parses root path", () => {
    expect(parseViewState("/", agents)).toEqual({
      mode: "root",
      activeAgentKey: null,
      activeSessionSlug: null,
    });
  });

  it("parses projects path", () => {
    expect(parseViewState("/projects", agents).mode).toBe("projects");
  });

  it("parses agent path", () => {
    const result = parseViewState("/claudecode", agents);
    expect(result).toEqual({
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionSlug: null,
    });
  });

  it("parses session path", () => {
    const result = parseViewState("/codex/abc-123", agents);
    expect(result).toEqual({
      mode: "session",
      activeAgentKey: "codex",
      activeSessionSlug: "abc-123",
    });
  });

  it("returns missingAgent for unknown agent", () => {
    const result = parseViewState("/unknown", agents);
    expect(result.mode).toBe("missingAgent");
  });

  it("returns invalidRoute for deeply nested paths", () => {
    expect(parseViewState("/a/b/c/d", agents).mode).toBe("invalidRoute");
  });
});
