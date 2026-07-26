import { describe, expect, it } from "vitest";
import {
  formatSessionReference,
  getSessionAgentKey,
  parseSessionReference,
} from "../session-reference.js";

describe("session references", () => {
  it("normalizes the agent name and preserves the opaque session ID", () => {
    const reference = parseSessionReference("CoDeX/nested/session");

    expect(reference).toEqual({
      agentName: "codex",
      sessionId: "nested/session",
    });
    expect(formatSessionReference({ ...reference!, agentName: " CoDeX " })).toBe(
      "codex/nested/session",
    );
  });

  it.each(["", "codex", "/session", "codex/"])("rejects malformed value %j", (value) => {
    expect(parseSessionReference(value)).toBeNull();
  });

  it("provides one explicit fallback for malformed legacy slugs", () => {
    expect(getSessionAgentKey({ slug: "" })).toBe("unknown");
    expect(getSessionAgentKey({ slug: "codex/session" })).toBe("codex");
  });
});
