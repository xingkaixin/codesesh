import { describe, expect, it } from "vitest";
import {
  agentRoutePath,
  formatSessionReference,
  getSessionAgentKey,
  getSessionRoutePath,
  normalizeSessionReference,
  parseSessionReference,
  sessionRoutePath,
} from "../session-reference.js";

/** Ids whose characters carry URL meaning, so a raw path would split or truncate. */
const OPAQUE_IDS = [
  "plain-session",
  "nested/session",
  "query?part",
  "fragment#part",
  "percent%part",
  "plus+and&amp",
  "空格 和 unicode ✓",
];

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
    expect(
      normalizeSessionReference({ agentName: " CoDeX ", sessionId: "nested/session" }),
    ).toEqual(reference);
  });

  it.each(["", "codex", "/session", "codex/"])("rejects malformed value %j", (value) => {
    expect(parseSessionReference(value)).toBeNull();
  });

  it("provides one explicit fallback for malformed legacy slugs", () => {
    expect(getSessionAgentKey({ slug: "" })).toBe("unknown");
    expect(getSessionAgentKey({ slug: "codex/session" })).toBe("codex");
  });
});

describe("session reference transport", () => {
  it.each(OPAQUE_IDS)("CS-132: round-trips %j through a route path", (sessionId) => {
    const path = sessionRoutePath({ agentName: "CoDeX", sessionId });
    const [, agentSegment, ...rest] = path.split("/");

    expect(rest).toHaveLength(1);
    expect(decodeURIComponent(agentSegment!)).toBe("codex");
    expect(decodeURIComponent(rest[0]!)).toBe(sessionId);
  });

  it("CS-132: leaves an ordinary id readable", () => {
    expect(sessionRoutePath({ agentName: "codex", sessionId: "abc-123" })).toBe("/codex/abc-123");
    expect(agentRoutePath(" CoDeX ")).toBe("/codex");
  });

  it("CS-132: derives the same path from a session head", () => {
    const session = { slug: "codex/nested/session", id: "nested/session" };

    expect(getSessionRoutePath(session)).toBe(
      sessionRoutePath({ agentName: "codex", sessionId: "nested/session" }),
    );
  });
});
